// Google Vertex AI (now "Gemini Enterprise Agent Platform") retirement dates, read by script from Google's own pages.
// Vertex sets its own dates; for Gemini they often differ from the Gemini API's (gemini-2.5-pro: Gemini API routes
// to a newer model on 1 Dec 2026, Vertex retired it on 20 Oct 2026).
//
//   node tools/vertex.mjs                 print what the pages say now (JSON)
//   node tools/vertex.mjs --write [path]  update platforms.vertex in registry/models.json; prints the changes
//   node tools/vertex.mjs --check [path]  exit 1 if the registry differs from the pages
//
// Three pages: Gemini/Imagen/Veo/embedding model versions (tables), partner models such as Claude (one paragraph per
// model: "… is deprecated as of <date> and will be shut down on <date>"), open models served as MaaS (table, IDs end
// in -maas). Only fixed dates are kept: "or later", "No sooner than" and "No retirement date announced" are not dates.
// Safety: refuses to write when a page yields too few models or too much changes at once (layout changed?).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/";
export const VERTEX_PAGES = { gemini: BASE + "model-versions", partner: BASE + "deprecations/partner-models", open: BASE + "deprecations/open-models" };
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const date = (s) => {
  const m = String(s || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/); // an exact date only, nothing around it
  return m && MONTHS[m[1].toLowerCase()] ? `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const text = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const kindOf = (id, section = "") => /embed|textembedding-gecko|(^|-)e5-/i.test(id) || (/embedding/i.test(section) && !/gecko/i.test(id)) ? "embedding"
  : /imagen|imagegeneration|-image\b|image-/i.test(id) || /image/i.test(section) ? "image"
  : /veo/i.test(id) || /veo/i.test(section) ? "video" : /-live|native-audio|tts|ocr/i.test(id) ? (/ocr/i.test(id) ? "text" : "audio") : "text";

// Tables with the heading they sit under: [{ section, rows: [[cell text, …], …] }]. Header rows (th) are dropped.
function tables(html) {
  const out = [];
  let section = "";
  const re = /<h([234])[^>]*>([\s\S]*?)<\/h\1>|<table[\s\S]*?<\/table>/g;
  for (const m of html.matchAll(re)) {
    if (m[1]) { section = text(m[2]); continue; }
    const rows = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => [...r[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]))).filter((r) => r.length);
    out.push({ section, rows });
  }
  return out;
}

// "gemini-3.8-flash or gemini-3.5-flash-lite or Gemma 4" → replacement + replacement_alt (model IDs only).
function replacements(cell) {
  const ids = String(cell || "").split(/\s+or\s+|,\s*/).map((s) => s.trim()).filter((s) => /^[a-z][\w.@-]+$/.test(s));
  return { ...(ids[0] ? { replacement: ids[0] } : {}), ...(ids[1] ? { replacement_alt: ids[1] } : {}) };
}

export function parseGemini(html) {
  const out = [];
  for (const t of tables(html)) {
    for (const r of t.rows) {
      const [id, released, retires, repl] = r;
      if (!/^[a-z][\w.@-]+$/.test(id || "")) continue;
      const d = date(retires);
      if (!d) continue; // "… or later", "No sooner than …", "No retirement date announced", blank
      out.push({ id: id.toLowerCase(), maker: "google", kind: kindOf(id, t.section), retires: d, ...(date(released) ? { released: date(released) } : {}), ...replacements(repl) });
    }
  }
  return out;
}

const PARTNER_MAKER = [[/anthropic|claude/i, "anthropic"], [/jamba|ai21/i, "ai21"], [/mistral|codestral/i, "mistral"], [/llama|meta/i, "meta"], [/qwen/i, "qwen"], [/deepseek/i, "deepseek"]];
export function parsePartner(html) {
  const t = text(html.slice(Math.max(0, html.indexOf("<article"))));
  const out = [];
  const re = /([A-Z][^.]{2,90}?) is deprecated as of ([A-Z][a-z]+ \d{1,2}, \d{4}) and (?:will be|was) shut down on ([A-Z][a-z]+ \d{1,2}, \d{4})/g;
  for (const m of t.matchAll(re)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const id = after.match(/Model ID\s+([a-z][\w.@-]+)/)?.[1];
    if (!id || !date(m[3])) continue;
    const name = m[1].replace(/^Anthropic's\s+/, "").replace(/\s+on Google Cloud$/, "").trim();
    out.push({ id: id.toLowerCase(), maker: PARTNER_MAKER.find(([r]) => r.test(m[1] + id))?.[1] || "other", name, kind: "text", deprecated: date(m[2]), retires: date(m[3]) });
  }
  return out;
}

const OPEN_MAKER = [[/^llama/, "meta"], [/^deepseek/, "deepseek"], [/^glm/, "zai"], [/^qwen/, "qwen"], [/^kimi/, "moonshot"], [/^gpt-oss/, "openai"], [/^(mistral|codestral|ministral)/, "mistral"], [/^minimax/, "minimax"], [/^gemma/, "google"]];
export function parseOpen(html) {
  const out = [];
  for (const t of tables(html)) for (const [id, deprecated, retires] of t.rows) {
    if (!/^[a-z][\w.@-]+-maas$/.test(id || "") || !date(retires)) continue;
    out.push({ id, maker: OPEN_MAKER.find(([r]) => r.test(id))?.[1] || "other", kind: kindOf(id), ...(date(deprecated) ? { deprecated: date(deprecated) } : {}), retires: date(retires) });
  }
  return out;
}

export async function fetchVertex(fetchImpl = fetch) {
  // English explicitly: without it Google's docs site sometimes serves a translated page, whose dates don't parse.
  const get = async (u) => { const r = await fetchImpl(`${u}?hl=en`, { headers: { "user-agent": "driftline-registry-check", "accept-language": "en-US,en;q=0.9" } }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
  // One page at a time, and a page that parses to nothing is fetched once more.
  const read = async (u, parse) => { let out = parse(await get(u)); if (!out.length) { await new Promise((r) => setTimeout(r, 3000)); out = parse(await get(u)); } return out; };
  const parts = { gemini: await read(VERTEX_PAGES.gemini, parseGemini), partner: await read(VERTEX_PAGES.partner, parsePartner), open: await read(VERTEX_PAGES.open, parseOpen) };
  const byId = new Map();
  for (const [from, list] of Object.entries(parts)) for (const m of list) if (!byId.has(m.id)) byId.set(m.id, { ...m, page: from });
  return { parts, models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diffVertex(old = [], now = []) {
  const o = new Map(old.map((m) => [m.id, m])), n = new Map(now.map((m) => [m.id, m]));
  const changes = [];
  for (const m of now) if (!o.has(m.id)) changes.push(`new: ${m.id} (${m.retires})`);
    else if (!same(o.get(m.id), m)) changes.push(`changed: ${m.id} (${o.get(m.id).retires} → ${m.retires}${o.get(m.id).replacement !== m.replacement ? `, replacement ${o.get(m.id).replacement || "none"} → ${m.replacement || "none"}` : ""})`);
  for (const m of old) if (!n.has(m.id)) changes.push(`gone from page: ${m.id}`);
  return changes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [mode, pathArg] = process.argv.slice(2);
  const path = pathArg || join(dirname(fileURLToPath(import.meta.url)), "..", "registry", "models.json");
  const { parts, models: now } = await fetchVertex();
  if (!mode) { console.log(JSON.stringify(now, null, 2)); process.exit(0); }
  const reg = JSON.parse(readFileSync(path, "utf8"));
  const old = reg.platforms?.vertex?.models || [];
  const changes = diffVertex(old, now);
  if (mode === "--check") { console.log(changes.length ? changes.join("\n") : "Vertex: matches the pages"); process.exit(changes.length ? 1 : 0); }
  if (mode === "--write") {
    // Each page must still parse to something: a redesign shows up as zero rows, not as "everything retired".
    const thin = [["model versions", parts.gemini.length, 15], ["partner models", parts.partner.length, 2], ["open models", parts.open.length, 3]].filter(([, n, min]) => n < min);
    if (thin.length) { console.error(`Vertex: ${thin.map(([p, n]) => `${p} page parsed to ${n} models`).join("; ")}; not writing (page layout changed?)`); process.exit(2); }
    if (old.length && changes.length > 15) { console.error(`Vertex: ${changes.length} changes at once; not writing, needs a look:\n${changes.join("\n")}`); process.exit(2); }
    if (!changes.length) { console.log("Vertex: no changes"); process.exit(0); }
    const today = new Date().toISOString().slice(0, 10);
    reg.platforms = { ...(reg.platforms || {}), vertex: { name: "Vertex AI", source: VERTEX_PAGES.gemini, sources: VERTEX_PAGES, checked: today, models: now } };
    writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
    console.log(`Vertex: ${changes.length} change${changes.length === 1 ? "" : "s"}\n${changes.join("\n")}`);
  }
}
