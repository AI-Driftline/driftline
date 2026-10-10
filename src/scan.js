import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import { normalizeId, looksLikeModelId } from "./registry.js";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt",
  "coverage", "__pycache__", ".venv", "venv", "target", ".turbo", ".cache",
]);
const EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".php", ".cs", ".swift", ".json", ".yaml", ".yml", ".toml", ".env", ".ini",
  ".cfg", ".md", ".txt", ".sh", ".tf", ".vue", ".svelte", ".astro", ".mts", ".cts", ".html",
  ".jsonc", ".ipynb",
]);
const MAX_BYTES = 1024 * 1024;
// Mentions in docs are reported but never fail the build (changelogs name old models on purpose).
const DOC_EXTENSIONS = new Set([".md", ".txt"]);
export const isDocFile = (file) => DOC_EXTENSIONS.has(extname(file).toLowerCase());

// Quoted strings: "gpt-4o", 'claude-3-haiku-20240307', `gemini-2.0-flash`
const QUOTED = /(["'`])([A-Za-z0-9][\w.\-:/@]{1,160})\1/g;
// Unquoted config values: MODEL=gpt-4o  or  model: claude-sonnet-4-5-20250929
// Bounded repeats keep this linear on long lines (minified files, generated data).
const ASSIGNED = /(?:^|[\s,{])[\w.\-]{0,40}model[\w.\-]{0,40}\s*[=:]\s*([A-Za-z0-9][\w.\-/]{1,80})\s*(?:#.*)?$/i;
const MAX_ASSIGNED_LINE = 2000;
// "o1", "o3": too short to trust without some sign the line is about a model.
const BARE_SHORT = /^o\d$/;
const MODEL_CONTEXT = /model|engine|llm|openai|reasoning/i;

export function* walk(root, dir = root) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, full);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      const isEnv = e.name.startsWith(".env");
      const isDocker = /^dockerfile/i.test(e.name) || ext === ".dockerfile";
      if (!EXTENSIONS.has(ext) && !isEnv && !isDocker) continue;
      if (e.name === "package-lock.json" || e.name.endsWith(".lock")) continue;
      try { if (statSync(full).size > MAX_BYTES) continue; } catch { continue; }
      yield { full, rel: relative(root, full) };
    }
  }
}

export function scanText(text, file, known) {
  const hits = [];
  const doc = isDocFile(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    // Escaped quotes (\"gpt-4\") appear in notebooks and JSON-in-JSON; read them as plain quotes.
    const line = raw.replace(/\\(["'`])/g, "$1");
    const seen = new Set();
    for (const m of line.matchAll(QUOTED)) seen.add(m[2]);
    if (line.length <= MAX_ASSIGNED_LINE && /model/i.test(line)) {
      const a = line.match(ASSIGNED);
      if (a) seen.add(a[1]);
    }
    const ids = [...seen].map(normalizeId).filter((id) => looksLikeModelId(id, known));
    const context = MODEL_CONTEXT.test(line) || ids.some((id) => !BARE_SHORT.test(id)); // e.g. ["o1", "gpt-4o"]
    for (const id of ids) {
      if (BARE_SHORT.test(id) && !context) continue;
      hits.push({ id, file, line: i + 1, doc, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

export function scanDirectory(root, { ignore = [], known } = {}) {
  const hits = [];
  for (const { full, rel } of walk(root)) {
    if (ignore.some((p) => rel.split(sep).join("/").startsWith(p))) continue;
    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue; // binary
    hits.push(...scanText(text, rel, known));
  }
  return hits;
}
