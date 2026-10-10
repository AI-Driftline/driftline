import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { normalizeId, looksLikeModelId } from "./registry.js";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt",
  "coverage", "__pycache__", ".venv", "venv", "target", ".turbo", ".cache",
]);
const EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".php", ".cs", ".swift", ".json", ".yaml", ".yml", ".toml", ".env", ".ini",
  ".cfg", ".md", ".txt", ".sh", ".tf",
]);
const MAX_BYTES = 1024 * 1024;

// Quoted strings: "gpt-4o", 'claude-3-haiku-20240307', `gemini-2.0-flash`
const QUOTED = /(["'`])([A-Za-z0-9][\w.\-:/]{1,80})\1/g;
// Unquoted config values: MODEL=gpt-4o  or  model: claude-sonnet-4-5-20250929
const ASSIGNED = /(?:^|[\s,{])[\w.\-]*model[\w.\-]*\s*[=:]\s*([A-Za-z0-9][\w.\-/]{1,80})\s*(?:#.*)?$/i;

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
      if (!EXTENSIONS.has(ext) && !isEnv) continue;
      if (e.name === "package-lock.json" || e.name.endsWith(".lock")) continue;
      try { if (statSync(full).size > MAX_BYTES) continue; } catch { continue; }
      yield { full, rel: relative(root, full) };
    }
  }
}

export function scanText(text, file, known) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const seen = new Set();
    for (const m of line.matchAll(QUOTED)) seen.add(m[2]);
    const a = line.match(ASSIGNED);
    if (a) seen.add(a[1]);
    for (const raw of seen) {
      const id = normalizeId(raw);
      if (looksLikeModelId(id, known)) hits.push({ id, file, line: i + 1, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

export function scanDirectory(root, { ignore = [], known } = {}) {
  const hits = [];
  for (const { full, rel } of walk(root)) {
    if (ignore.some((p) => rel.startsWith(p))) continue;
    let text;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue; // binary
    hits.push(...scanText(text, rel, known));
  }
  return hits;
}
