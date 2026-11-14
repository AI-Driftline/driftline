// Retirement dates from more model providers' own pages, read by script (no AI): Groq, Mistral AI, xAI and Cohere.
// DeepSeek has no such page; its entries (platforms.deepseek) are kept by the daily AI check (docs/registry-rules.md).
//
//   node tools/direct.mjs                 print what the pages say now (JSON per provider)
//   node tools/direct.mjs --write [path]  update platforms.<provider> in registry/models.json; prints the changes
//   node tools/direct.mjs --check [path]  exit 1 if the registry differs from the pages
//
// Sources and shapes:
//   Groq     console.groq.com/docs/deprecations   one table per announcement: model | shutdown date (MM/DD/YY) | replacement ID
//   Mistral  docs.mistral.ai/models.md            "Deprecated and retired models" table; replacement named by product, mapped to its API name
//   xAI      docs.x.ai/llms.txt → migration guides  "# … Retirement on <date>" + table: retired slug | redirect target (calls are redirected)
//   Cohere   docs.cohere.com/docs/deprecations.md  "Effective <date>, the following models will be retired:" + bullet list of IDs
// Each provider is written on its own; one that fails to read (or reads too few models) is skipped and reported, the rest still update.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const SOURCES = {
  groq: { name: "Groq", page: "https://console.groq.com/docs/deprecations", min: 10 },
  mistral: { name: "Mistral AI", page: "https://docs.mistral.ai/models", md: "https://docs.mistral.ai/models.md", min: 5 },
  xai: { name: "xAI", page: "https://docs.x.ai/developers/models", index: "https://docs.x.ai/llms.txt", min: 3 },
  cohere: { name: "Cohere", page: "https://docs.cohere.com/docs/deprecations", md: "https://docs.cohere.com/docs/deprecations.md", min: 5 },
};
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = (n) => String(n).padStart(2, "0");
const longDate = (s) => { const m = String(s).match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/); return m && MONTHS[m[1].toLowerCase()] ? `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}` : null; };
const text = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const kindOf = (id) => /embed|rerank/i.test(id) ? "embedding" : /tts|whisper|voxtral|transcribe|audio|speech/i.test(id) ? "audio"
  : /image|imagine|vision-only|ocr/i.test(id) ? (/ocr/i.test(id) ? "text" : "image") : /video/i.test(id) ? "video" : "text";
const byIdOnce = (list) => { const m = new Map(); for (const x of list) if (!m.has(x.id)) m.set(x.id, x); return [...m.values()].sort((a, b) => a.id.localeCompare(b.id)); };

// Groq: <table> per announcement; dates are MM/DD/YY.
export function parseGroq(html) {
  const out = [];
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const head = [...t[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((h) => text(h[1]).toLowerCase());
    const [ci, cd, cr] = [head.findIndex((h) => /deprecated model/.test(h)), head.findIndex((h) => /shutdown date/.test(h)), head.findIndex((h) => /replacement/.test(h))];
    if (ci < 0 || cd < 0) continue;
    for (const r of t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)) {
      const c = [...r[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]));
      const d = c[cd]?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
      const id = c[ci]?.toLowerCase();
      if (!d || !/^[a-z0-9][\w./:-]+$/.test(id || "")) continue;
      const repl = (cr >= 0 ? c[cr] : "").split(/\s+or\s+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][\w./:-]+$/.test(s));
      out.push({ id, maker: groqMaker(id), kind: kindOf(id), retires: `${d[3].length === 2 ? "20" + d[3] : d[3]}-${pad(d[1])}-${pad(d[2])}`,
        ...(repl[0] ? { replacement: repl[0] } : {}), ...(repl[1] ? { replacement_alt: repl[1] } : {}) });
    }
  }
  return byIdOnce(out);
}
const groqMaker = (id) => /^(meta-llama\/|llama)/.test(id) ? "meta" : /^qwen/.test(id) ? "qwen" : /^(openai\/|whisper|distil-whisper)/.test(id) ? "openai"
  : /^moonshotai\//.test(id) ? "moonshot" : /^(gemma|google\/)/.test(id) ? "google" : /^deepseek/.test(id) ? "deepseek" : /^mistral|^mixtral/.test(id) ? "mistral"
  : /^playai/.test(id) ? "playai" : /^groq\/|^compound/.test(id) ? "groq" : "other";

// Mistral: markdown tables. Every table maps product name → API name; the deprecated one adds dates and a replacement name.
export function parseMistral(md) {
  const names = new Map();
  for (const m of md.matchAll(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|\s*`([^`]+)`/gm)) if (!names.has(m[1].trim())) names.set(m[1].trim(), m[2].trim());
  const out = [];
  const sec = md.split(/^## /m).find((s) => /^Deprecated and retired models/i.test(s)) || "";
  const head = (sec.match(/^\|\s*Model\s*\|.*$/m)?.[0] || "").split("|").slice(1, -1).map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n);
  const [ca, cs, cd, cr, cx] = [col("api name"), col("status"), col("deprecation"), col("retirement"), col("replacement")];
  for (const line of sec.split("\n")) {
    if (!/^\|\s*\[/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    const id = c[ca]?.replace(/`/g, "").trim().toLowerCase();
    const retires = c[cr]?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
    if (!id || !retires) continue;
    const replName = c[cx]?.match(/\[([^\]]+)\]/)?.[1]?.trim();
    const replacement = replName ? names.get(replName) : null;
    out.push({ id, name: c[0].match(/\[([^\]]+)\]/)?.[1] || id, maker: /^zai-/.test(id) ? "zai" : /^deepseek/.test(id) ? "deepseek" : "mistral", kind: kindOf(id),
      ...(c[cs] ? { lifecycle: c[cs] } : {}), ...(c[cd]?.match(/^\d{4}-\d{2}-\d{2}$/) ? { deprecated: c[cd] } : {}), retires,
      ...(replacement ? { replacement } : replName ? { replacement_note: `Mistral recommends ${replName}` } : {}) });
  }
  return byIdOnce(out);
}

// xAI: one migration guide per retirement. Calls to a retired slug are redirected, not refused (routes: true).
export function parseXaiGuide(md) {
  const date = longDate(md.match(/^#\s+.*Retirement on ([A-Za-z]+ \d{1,2}, \d{4})/m)?.[1] || md.match(/Effective \*\*([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] || "");
  if (!date) return [];
  const out = [];
  for (const m of md.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gm)) {
    const target = m[2].match(/`([^`]+)`/)?.[1];
    // "`grok-4.3` with `low` reasoning effort" → reasoning_effort: low; '`x` with `quality: "low"`' → quality: "low"
    let extra = m[2].replace(/`[^`]+`/, "").replace(/`/g, "").replace(/^\s*with\s+/, "").trim();
    extra = extra.replace(/^(\w+) reasoning effort$/i, "reasoning_effort: $1");
    out.push({ id: m[1].toLowerCase(), maker: "xai", kind: kindOf(m[1]), retires: date, routes: true,
      ...(target ? { replacement: target.toLowerCase() } : {}), ...(extra ? { replacement_note: extra } : {}) });
  }
  return out;
}
export const xaiGuideLinks = (llms) => [...new Set([...llms.matchAll(/\((https:\/\/docs\.x\.ai\/developers\/migration\/[^)]+\.md)\)/g)].map((m) => m[1]))];

// Cohere: "### <date>: …" sections; "Effective <date>, the following models will be retired" (or "deprecations will roll out")
// followed by a bullet list of IDs. Endpoints (/v1/…) and features are skipped; "(and the alias `x`)" adds x too.
const COHERE_NOT_MODELS = new Set(["summarize", "classify", "rerank", "generate", "chat", "embed", "connectors"]);
export function parseCohere(md) {
  const out = [];
  for (const sec of md.split(/^### /m).slice(1)) {
    const eff = longDate(sec.match(/Effective ([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4})/)?.[1] || "") || sec.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!eff || !/following (?:models will be retired|deprecations will roll out)/i.test(sec)) continue;
    // IDs in the first bullet list after that sentence, up to the alternatives / the next paragraph about something else.
    // Cohere's suggested replacements: "Embedding tasks alternatives:" / "Chat tasks alternatives:" lists, or "we recommend you use `x`, `y`".
    const listAfter = (re) => { const m = sec.split(re)[1]; return m ? [...m.split(/\n(?!\s+[*-])/)[0].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : null; };
    const suggestions = { embed: listAfter(/Embedding tasks alternatives:/i), chat: listAfter(/Chat tasks alternatives:/i),
      any: [...(sec.match(/recommend you use ([^\n.]*)/i)?.[1] || "").matchAll(/`([^`]+)`/g)].map((x) => x[1]) };
    let after = sec.split(/following (?:models will be retired|deprecations will roll out)[^\n]*\n/i)[1] || "";
    after = after.replace(/^\s*(?:\*\*)?(?:Deprecated|Retired) Models:?(?:\*\*)?:?\s*\n/i, "\n"); // "Deprecated Models:" label before the list
    const block = after.split(/\n(?![\s*-])|alternatives:/i)[0]; // the bullet list, up to the next paragraph
    for (const line of block.split("\n")) {
      if (!/^\s*[*-]\s/.test(line) || /\//.test(line.match(/`([^`]+)`/)?.[1] || "/")) continue;
      for (const id of [...line.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim().toLowerCase())) {
        if (COHERE_NOT_MODELS.has(id) || !/^[a-z0-9][\w.-]+$/.test(id)) continue;
        const suggest = (kindOf(id) === "embedding" ? suggestions.embed : suggestions.chat) || suggestions.any;
        out.push({ id, maker: "cohere", kind: kindOf(id), retires: eff, ...(suggest?.length ? { replacement_note: `Cohere suggests ${suggest.slice(0, -1).join(", ")}${suggest.length > 1 ? " or " : ""}${suggest.at(-1)}` } : {}) });
      }
    }
  }
  return byIdOnce(out);
}

const get = async (u, fetchImpl) => { const r = await fetchImpl(u, { headers: { "user-agent": "driftline-registry-check", "accept-language": "en-US,en;q=0.9" } }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.text(); };
export async function fetchProvider(name, fetchImpl = fetch) {
  if (name === "groq") return parseGroq(await get(SOURCES.groq.page, fetchImpl));
  if (name === "mistral") return parseMistral(await get(SOURCES.mistral.md, fetchImpl));
  if (name === "cohere") return parseCohere(await get(SOURCES.cohere.md, fetchImpl));
  if (name === "xai") {
    const out = [];
    for (const u of xaiGuideLinks(await get(SOURCES.xai.index, fetchImpl))) out.push(...parseXaiGuide(await get(u, fetchImpl)));
    return byIdOnce(out);
  }
  throw new Error(`unknown provider ${name}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diffModels(old = [], now = []) {
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
  const reg = mode ? JSON.parse(readFileSync(path, "utf8")) : null;
  let failed = 0, wrote = false;
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, src] of Object.entries(SOURCES)) {
    let now;
    try { now = await fetchProvider(key); } catch (e) { console.error(`${src.name}: couldn't read the page (${e.message})`); failed++; continue; }
    if (!mode) { console.log(JSON.stringify({ [key]: now }, null, 2)); continue; }
    const old = reg.platforms?.[key]?.models || [];
    const changes = diffModels(old, now);
    if (mode === "--check") { console.log(changes.length ? `${src.name}:\n${changes.join("\n")}` : `${src.name}: matches the page`); if (changes.length) failed++; continue; }
    if (now.length < src.min) { console.error(`${src.name}: page parsed to only ${now.length} models; not writing (page layout changed?)`); failed++; continue; }
    if (old.length && changes.length > 15) { console.error(`${src.name}: ${changes.length} changes at once; not writing, needs a look:\n${changes.join("\n")}`); failed++; continue; }
    if (!changes.length) { console.log(`${src.name}: no changes`); continue; }
    reg.platforms = { ...(reg.platforms || {}), [key]: { name: src.name, direct: true, source: src.page, checked: today, models: now } };
    wrote = true;
    console.log(`${src.name}: ${changes.length} change${changes.length === 1 ? "" : "s"}\n${changes.join("\n")}`);
  }
  if (wrote) writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
  process.exit(failed ? (mode === "--check" ? 1 : 2) : 0);
}
