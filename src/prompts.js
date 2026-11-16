import { readFileSync, existsSync } from "node:fs";
import { normalizeId } from "./registry.js";

/**
 * Load the prompt file. JSON is parsed as-is. YAML supports the documented subset:
 *
 * prompts:
 *   - id: invoice-json
 *     model: gpt-4o-2024-05-13       # optional
 *     compare_to: gpt-5.6-sol        # optional; defaults to the registry replacement
 *     expect: json                   # optional: json | text
 *     same_fields: [vendor, total]   # optional checks: same_fields (json), must_include, must_not_include
 *     system: You extract invoice fields.
 *     prompt: |
 *       Extract the fields from this invoice as JSON:
 *       ...
 *
 * Block values can be literal (|) or folded (>), with optional chomping (+ or -).
 */
export function loadPrompts(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const data = path.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYamlSubset(text);
  const list = Array.isArray(data) ? data : data?.prompts;
  if (!Array.isArray(list)) throw new Error(`${path}: expected a "prompts:" list`);
  return list.map((p, i) => {
    if (!p.prompt) throw new Error(`${path}: prompt #${i + 1} has no "prompt" field`);
    const expect = String(p.expect || "text").toLowerCase();
    const checks = {};
    for (const key of CHECKS) {
      if (p[key] === undefined) continue;
      const items = toList(p[key]);
      if (!items.length) throw new Error(`${path}: prompt #${i + 1} has an empty "${key}" list`);
      checks[key] = items;
    }
    if (checks.same_fields && expect !== "json") throw new Error(`${path}: prompt #${i + 1} uses "same_fields", which needs "expect: json"`);
    return {
      ...p,
      ...checks,
      id: String(p.id || `prompt-${i + 1}`).replace(/[\r\n]+/g, " "),
      expect,
      ...(p.model ? { model: normalizeId(String(p.model).replace(/\s+/g, "")) } : {}),
      ...(p.compare_to ? { compare_to: normalizeId(String(p.compare_to).replace(/\s+/g, "")) } : {}),
    };
  });
}

export const CHECKS = ["must_include", "must_not_include", "same_fields"];

// A check list from JSON (an array), a one-line YAML list ([a, "b, c"]) or a single value.
export function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const v = String(value ?? "").trim();
  if (!(v.startsWith("[") && v.endsWith("]"))) return v ? [v] : [];
  const items = [];
  let cur = "", quote = null, quoted = false;
  const body = v.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < body.length) { cur += body[++i]; continue; }
      if (c === quote) { if (quote === "'" && body[i + 1] === "'") { cur += "'"; i++; continue; } quote = null; continue; }
      cur += c;
    } else if ((c === '"' || c === "'") && !cur.trim()) { quote = c; quoted = true; cur = ""; }
    else if (c === ",") { if (cur.trim() || quoted) items.push(quoted ? cur : cur.trim()); cur = ""; quoted = false; }
    else cur += c;
  }
  if (cur.trim() || quoted) items.push(quoted ? cur : cur.trim());
  return items.filter((s) => s.trim());
}

export function parseYamlSubset(text) {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  const out = { prompts: [] };
  let item = null;
  let block = null; // { key, indent, lines }
  let list = null; // a key with no value, which may be followed by "- item" lines: { key, col }

  const flushBlock = () => {
    if (block && item) {
      const lines = block.lines.join("\n").replace(/\n+$/, "").split("\n");
      // Folded (>): lines join with spaces; a blank line starts a new paragraph.
      item[block.key] = block.folded
        ? lines.join("\n").split(/\n{2,}/).map((para) => para.split("\n").join(" ")).join("\n")
        : lines.join("\n");
    }
    block = null;
  };
  const scalar = (v) => {
    v = v.trim();
    let q = v.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (q) return JSON.parse(`"${q[1]}"`);
    q = v.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (q) return q[1].replace(/''/g, "'");
    return v.replace(/\s+#.*$/, "").trim();
  };

  for (const raw of lines) {
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (block) {
      if (block.indent === null && line !== "") {
        if (indent > block.keyCol) block.indent = indent;
      }
      if (line === "" || (block.indent !== null && indent >= block.indent)) {
        block.lines.push(line === "" ? "" : raw.slice(block.indent));
        continue;
      }
      flushBlock();
    }
    if (line === "" || line.startsWith("#")) continue;
    if (list && indent >= list.col && /^-(\s|$)/.test(line)) {
      if (!Array.isArray(item[list.key])) item[list.key] = [];
      item[list.key].push(scalar(line.slice(1)));
      continue;
    }
    list = null;
    if (indent === 0 && /^(---|\.\.\.)(\s.*)?$/.test(line)) continue; // YAML document markers
    if (/^prompts:\s*(\[\s*\])?\s*(#.*)?$/.test(line) && indent === 0) continue;

    let m = line.match(/^-\s+([\w-]+):\s*(.*)$/);
    if (m) {
      item = {};
      out.prompts.push(item);
    } else {
      m = line.match(/^([\w-]+):\s*(.*)$/);
      if (!m || !item) throw new Error(`Cannot read prompt file line: "${raw}"`);
    }
    const [, key, value] = m;
    const blockStart = value.replace(/\s+#.*$/, "").match(/^([|>])[+-]?$/);
    if (blockStart) {
      const keyCol = indent + (raw.trimStart().startsWith("-") ? 2 : 0);
      block = { key, keyCol, indent: null, lines: [], folded: blockStart[1] === ">" };
    } else {
      item[key] = scalar(value);
      if (item[key] === "") list = { key, col: indent + (raw.trimStart().startsWith("-") ? 2 : 0) };
    }
  }
  flushBlock();
  return out;
}
