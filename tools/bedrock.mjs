// Amazon Bedrock retirement dates, read by script from AWS's own page (no AI involved).
// Bedrock sets its own dates per model and per region; AWS: "For Amazon Bedrock usage, only the dates on this page apply."
//
//   node tools/bedrock.mjs                 print what the page says now (JSON)
//   node tools/bedrock.mjs --write [path]  update platforms.bedrock in registry/models.json; prints a summary of changes
//   node tools/bedrock.mjs --check [path]  exit 1 if the registry differs from the page (used by the page check)
//
// Safety: refuses to write when the page parses to fewer than 15 models or when more than 15 entries would change,
// so a redesigned page or a bad fetch never wipes the data. Those cases need a person (or the AI check) to look.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const BEDROCK_PAGE = "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html";
const MD = "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.md";
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const date = (s) => {
  const m = String(s || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  return m && MONTHS[m[1].toLowerCase()] ? `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const MAKER = { "ai21 labs": "ai21", amazon: "amazon", anthropic: "anthropic", cohere: "cohere", deepseek: "deepseek", google: "google", meta: "meta", minimax: "minimax", "mistral ai": "mistral", "moonshot ai": "moonshot", nvidia: "nvidia", openai: "openai", qwen: "qwen", twelvelabs: "twelvelabs", writer: "writer", "z.ai": "zai", stability: "stability", "stability ai": "stability", luma: "luma", "luma ai": "luma" };
const kindOf = (id, name) => /embed/i.test(id) ? "embedding" : /canvas|image|stable-|sd3|titan-image/i.test(id) ? "image"
  : /reel|ray-|pegasus/i.test(id) ? "video" : /sonic|voxtral/i.test(id) ? "audio" : "text";

// Parse the markdown version of the page: "- **Maker**" blocks with "Model name", "Model ID", then either one
// Regions/Legacy/EOL group on separate lines or several "Regions: … / Legacy date: … / EOL date: …" lines.
export function parseBedrock(md) {
  const models = [];
  let cur = null, group = null;
  const flush = () => { if (cur?.ids.length && cur.regions.length) models.push(cur); cur = null; };
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\\\+/g, "+").trim();
    const maker = line.match(/^- \*\*([^*]+)\*\*\s*$/);
    if (maker) { flush(); cur = { maker: MAKER[maker[1].trim().toLowerCase()] || maker[1].trim().toLowerCase().replace(/\W+/g, ""), name: "", ids: [], regions: [] }; group = null; continue; }
    if (!cur) continue;
    const field = (label) => line.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^/]*?)\\s*(?:/|$)`, "i"))?.[1];
    if (/\*\*Model name:\*\*/i.test(line)) cur.name = field("Model name");
    else if (/\*\*Model ID:\*\*/i.test(line)) {
      // "deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-mantle)"
      cur.ids = line.split(/\*\*Model ID:\*\*/i)[1].split(",").map((s) => s.replace(/\(.*?\)/g, "").trim().toLowerCase()).filter(Boolean);
    } else if (/\*\*Regions:\*\*/i.test(line)) {
      group = { regions: field("Regions").split(",").map((r) => r.trim()).filter(Boolean), legacy: date(field("Legacy date")), retires: date(field("EOL date")), extended: date(field("Public extended access start date")) };
      cur.regions.push(group);
    } else if (group && /\*\*Legacy date:\*\*/i.test(line)) group.legacy = date(field("Legacy date"));
    else if (group && /\*\*EOL date:\*\*/i.test(line)) group.retires = date(field("EOL date"));
    else if (group && /\*\*Public extended access start date:\*\*/i.test(line)) group.extended = date(field("Public extended access start date"));
    else if (/^\*\*Models that have reached EOL\*\*|^\*\*Customized Models/i.test(line)) { flush(); group = null; }
  }
  flush();
  // One entry per model ID. A model listed under both "scheduled" and "reached EOL" (different regions) is merged.
  const byId = new Map();
  for (const m of models) for (const id of m.ids) {
    const e = byId.get(id) || { id, maker: m.maker, name: m.name, kind: kindOf(id, m.name), regions: [] };
    for (const g of m.regions) if (g.retires) e.regions.push({ ...g });
    byId.set(id, e);
  }
  const out = [];
  for (const e of byId.values()) {
    if (!e.regions.length) continue;
    e.regions.sort((a, b) => a.retires.localeCompare(b.retires));
    // The earliest EOL is the date reported: code rarely says which region it runs in. The per-region list stays.
    e.retires = e.regions[0].retires;
    e.legacy = e.regions.map((g) => g.legacy).filter(Boolean).sort()[0] || null;
    e.extended = e.regions.map((g) => g.extended).filter(Boolean).sort()[0] || null;
    if (!e.extended) delete e.extended;
    for (const g of e.regions) if (!g.extended) delete g.extended;
    out.push(e);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchBedrock(fetchImpl = fetch) {
  const r = await fetchImpl(MD, { headers: { "user-agent": "driftline-registry-check" } });
  if (!r.ok) throw new Error(`Bedrock page: HTTP ${r.status}`);
  return parseBedrock(await r.text());
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diffBedrock(old = [], now = []) {
  const o = new Map(old.map((m) => [m.id, m])), n = new Map(now.map((m) => [m.id, m]));
  const changes = [];
  for (const m of now) if (!o.has(m.id)) changes.push(`new: ${m.id} (EOL ${m.retires})`);
    else if (!same(o.get(m.id), m)) changes.push(`changed: ${m.id} (EOL ${o.get(m.id).retires} → ${m.retires}${same(o.get(m.id).regions, m.regions) ? "" : ", regions"})`);
  for (const m of old) if (!n.has(m.id)) changes.push(`gone from page: ${m.id}`);
  return changes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [mode, pathArg] = process.argv.slice(2);
  const path = pathArg || join(dirname(fileURLToPath(import.meta.url)), "..", "registry", "models.json");
  const now = await fetchBedrock();
  if (!mode) { console.log(JSON.stringify(now, null, 2)); process.exit(0); }
  const reg = JSON.parse(readFileSync(path, "utf8"));
  const old = reg.platforms?.bedrock?.models || [];
  const changes = diffBedrock(old, now);
  if (mode === "--check") { console.log(changes.length ? changes.join("\n") : "Bedrock: matches the page"); process.exit(changes.length ? 1 : 0); }
  if (mode === "--write") {
    if (now.length < 15) { console.error(`Bedrock: page parsed to only ${now.length} models; not writing (page layout changed?)`); process.exit(2); }
    if (old.length && changes.length > 15) { console.error(`Bedrock: ${changes.length} changes at once; not writing, needs a look:\n${changes.join("\n")}`); process.exit(2); }
    if (!changes.length) { console.log("Bedrock: no changes"); process.exit(0); }
    const today = new Date().toISOString().slice(0, 10);
    reg.platforms = { ...(reg.platforms || {}), bedrock: { name: "Amazon Bedrock", source: BEDROCK_PAGE, checked: today, models: now } };
    writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
    console.log(`Bedrock: ${changes.length} change${changes.length === 1 ? "" : "s"}\n${changes.join("\n")}`);
  }
}
