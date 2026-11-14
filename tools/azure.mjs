// Microsoft Azure (Azure OpenAI and other Foundry models) retirement dates, read by script from Microsoft's own page.
// Azure sets its own dates per model version, and they often differ from the model maker's: o3 retires on Azure on
// 19 Nov 2026 but on OpenAI's API on 11 Dec 2026; gpt-5 on Azure 9 Feb 2027.
//
//   node tools/azure.mjs                 print what the page says now (JSON)
//   node tools/azure.mjs --write [path]  update platforms.azure in registry/models.json; prints the changes
//   node tools/azure.mjs --check [path]  exit 1 if the registry differs from the page
//
// The page has one table per model maker: Model | Version | Lifecycle | Retirement date | Replacement. Only fixed
// dates are kept ("No earlier than …" is not a date). Fine-tuned models (training/deployment dates) are left out.
// Safety: refuses to write when the page yields too few models or too much changes at once (layout changed?).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const AZURE_PAGE = "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule";
const text = (h) => String(h).replace(/<sup>[\s\S]*?<\/sup>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const MAKER = { "azure openai": "openai", "openai-oss": "openai", anthropic: "anthropic", meta: "meta", microsoft: "microsoft", "mistral ai": "mistral", moonshotai: "moonshot", xai: "xai", deepseek: "deepseek", cohere: "cohere", "black forest labs": "bfl", stabilityai: "stability", nixtla: "nixtla", "ntt data": "ntt", fireworks: "fireworks" };
const kindOf = (id) => /embed/i.test(id) ? "embedding" : /transcribe|tts|audio|realtime|whisper/i.test(id) ? "audio"
  : /sora|video/i.test(id) ? "video" : /image|dall-e|flux|stable|sd3/i.test(id) ? "image" : "text";
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseAzure(html) {
  const byId = new Map();
  let maker = "";
  const re = /<h([234])[^>]*>([\s\S]*?)<\/h\1>|<table[\s\S]*?<\/table>/g;
  for (const m of html.matchAll(re)) {
    if (m[1] === "3") { maker = text(m[2]).toLowerCase(); continue; }
    if (m[1]) continue; // h2 (sold by Azure / partners) and h4 ("Fine-tuned models" is skipped by its header below)
    const head = [...m[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((h) => text(h[1]).toLowerCase());
    const col = (name) => head.findIndex((h) => h === name);
    const [ci, cv, cl, cr, cx] = [col("model"), col("version"), col("lifecycle"), col("retirement date"), col("replacement")];
    if (ci < 0 || cr < 0) continue; // e.g. fine-tuned models: training / deployment retirement dates
    for (const r of m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const c = [...r[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]));
      if (!c.length || !c[ci] || !isDate(c[cr])) continue;
      const id = c[ci].replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase(); // "claude-mythos-preview (gated research preview)"
      const repl = cx >= 0 ? c[cx].match(/^([A-Za-z0-9][\w.:-]*)(?:\s*\(([^)]+)\))?$/) : null;
      const v = { version: cv >= 0 ? c[cv] : "", ...(cl >= 0 && c[cl] ? { lifecycle: c[cl] } : {}), retires: c[cr],
        ...(repl ? { replacement: repl[1].toLowerCase(), ...(repl[2] ? { replacement_version: repl[2] } : {}) } : {}) };
      const e = byId.get(id) || { id, name: c[ci], maker: MAKER[maker] || maker.replace(/\W+/g, "") || "other", kind: kindOf(id), versions: [] };
      if (!e.versions.some((x) => x.version === v.version)) e.versions.push(v);
      byId.set(id, e);
    }
  }
  const out = [];
  for (const e of byId.values()) {
    e.versions.sort((a, b) => a.retires.localeCompare(b.retires) || a.version.localeCompare(b.version));
    // Without a known version in the code, the earliest version's date is the one to plan for.
    e.retires = e.versions[0].retires;
    if (e.versions[0].replacement) e.replacement = e.versions[0].replacement;
    out.push(e);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchAzure(fetchImpl = fetch) {
  const get = async () => { const r = await fetchImpl(AZURE_PAGE, { headers: { "user-agent": "driftline-registry-check", "accept-language": "en-US,en;q=0.9" } }); if (!r.ok) throw new Error(`Azure page: HTTP ${r.status}`); return r.text(); };
  let out = parseAzure(await get());
  if (out.length < 40) { await new Promise((r) => setTimeout(r, 3000)); out = parseAzure(await get()); } // one retry
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diffAzure(old = [], now = []) {
  const o = new Map(old.map((m) => [m.id, m])), n = new Map(now.map((m) => [m.id, m]));
  const changes = [];
  for (const m of now) if (!o.has(m.id)) changes.push(`new: ${m.id} (${m.versions.map((v) => `${v.version || "-"} ${v.retires}`).join(", ")})`);
    else if (!same(o.get(m.id), m)) changes.push(`changed: ${m.id} (${o.get(m.id).versions.map((v) => `${v.version || "-"} ${v.retires}`).join(", ")} → ${m.versions.map((v) => `${v.version || "-"} ${v.retires}`).join(", ")})`);
  for (const m of old) if (!n.has(m.id)) changes.push(`gone from page: ${m.id}`);
  return changes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [mode, pathArg] = process.argv.slice(2);
  const path = pathArg || join(dirname(fileURLToPath(import.meta.url)), "..", "registry", "models.json");
  const now = await fetchAzure();
  if (!mode) { console.log(JSON.stringify(now, null, 2)); process.exit(0); }
  const reg = JSON.parse(readFileSync(path, "utf8"));
  const old = reg.platforms?.azure?.models || [];
  const changes = diffAzure(old, now);
  if (mode === "--check") { console.log(changes.length ? changes.join("\n") : "Azure: matches the page"); process.exit(changes.length ? 1 : 0); }
  if (mode === "--write") {
    if (now.length < 40) { console.error(`Azure: page parsed to only ${now.length} models; not writing (page layout changed?)`); process.exit(2); }
    if (old.length && changes.length > 15) { console.error(`Azure: ${changes.length} changes at once; not writing, needs a look:\n${changes.join("\n")}`); process.exit(2); }
    if (!changes.length) { console.log("Azure: no changes"); process.exit(0); }
    const today = new Date().toISOString().slice(0, 10);
    reg.platforms = { ...(reg.platforms || {}), azure: { name: "Azure", source: AZURE_PAGE, checked: today, models: now } };
    writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
    console.log(`Azure: ${changes.length} change${changes.length === 1 ? "" : "s"}\n${changes.join("\n")}`);
  }
}
