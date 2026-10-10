import { readFileSync, existsSync } from "node:fs";

/**
 * Load the prompt file. JSON is parsed as-is. YAML supports the documented subset:
 *
 * prompts:
 *   - id: invoice-json
 *     model: gpt-4o-2024-05-13       # optional
 *     compare_to: gpt-5.6-sol        # optional; defaults to the registry replacement
 *     expect: json                   # optional: json | text
 *     system: You extract invoice fields.
 *     prompt: |
 *       Extract the fields from this invoice as JSON:
 *       ...
 */
export function loadPrompts(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const data = path.endsWith(".json") ? JSON.parse(text) : parseYamlSubset(text);
  const list = Array.isArray(data) ? data : data?.prompts;
  if (!Array.isArray(list)) throw new Error(`${path}: expected a "prompts:" list`);
  return list.map((p, i) => {
    if (!p.prompt) throw new Error(`${path}: prompt #${i + 1} has no "prompt" field`);
    return { id: p.id || `prompt-${i + 1}`, expect: p.expect || "text", ...p };
  });
}

export function parseYamlSubset(text) {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/);
  const out = { prompts: [] };
  let item = null;
  let block = null; // { key, indent, lines }

  const flushBlock = () => {
    if (block && item) item[block.key] = block.lines.join("\n").replace(/\n+$/, "");
    block = null;
  };
  const scalar = (v) => {
    v = v.replace(/\s+#.*$/, "").trim();
    if (/^".*"$/.test(v)) return JSON.parse(v);
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    return v;
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
    if (/^prompts:\s*$/.test(line) && indent === 0) continue;

    let m = line.match(/^-\s+([\w-]+):\s*(.*)$/);
    if (m) {
      item = {};
      out.prompts.push(item);
    } else {
      m = line.match(/^([\w-]+):\s*(.*)$/);
      if (!m || !item) throw new Error(`Cannot read prompt file line: "${raw}"`);
    }
    const [, key, value] = m;
    if (value === "|" || value === "|-") {
      const keyCol = indent + (raw.trimStart().startsWith("-") ? 2 : 0);
      block = { key, keyCol, indent: null, lines: [] };
    } else {
      item[key] = scalar(value);
    }
  }
  flushBlock();
  return out;
}
