import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

export const REGISTRY_PATH = join(here, "..", "registry", "models.json");

export function loadRegistry(path = REGISTRY_PATH) {
  return buildRegistry(JSON.parse(readFileSync(path, "utf8")));
}

// The live registry is updated as soon as a provider changes a date or replacement; the copy bundled with a
// release can be days or weeks old. Everything (Action, CLI, MCP) uses the live copy when it can be read, looks
// like ours and is at least as new as the bundled one; otherwise the bundled copy. reg.source says which.
export const LIVE_URL = "https://aidriftline.com/models.json";
export function validRegistry(data) {
  return Array.isArray(data?.models) && data.models.length >= 50 && /^\d{4}-\d{2}-\d{2}$/.test(data.checked || "") &&
    data.models.every((m) => typeof m?.id === "string" && ["openai", "anthropic", "google"].includes(m.provider) && /^\d{4}-\d{2}-\d{2}$/.test(m.retires || ""));
}
export async function loadBestRegistry({ fetchImpl = fetch, offline = process.env.DRIFTLINE_OFFLINE === "1", timeoutMs = 4000 } = {}) {
  const bundled = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const use = (data, source, why = "") => { const reg = buildRegistry(data); reg.source = source; reg.sourceWhy = why; return { reg, source, why }; };
  if (offline) return use(bundled, "bundled", "offline");
  try {
    const res = await fetchImpl(LIVE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const live = res.ok ? await res.json() : null;
    if (validRegistry(live)) return live.checked >= bundled.checked ? use(live, "live") : use(bundled, "bundled", "newer");
  } catch { /* offline, slow or malformed: use the bundled copy */ }
  return use(bundled, "bundled", "unreachable");
}

// Same as loadRegistry, from already-parsed JSON (e.g. the live copy at aidriftline.com/models.json).
export function buildRegistry(data) {
  const byId = new Map(data.models.map((m) => [m.id, { ...m }]));
  // Providers sometimes name a replacement that is itself being retired (o1-mini -> o4-mini -> ...).
  // Follow the chain so customers are pointed at a model that stays.
  for (const m of byId.values()) {
    if (!m.replacement) continue;
    const seen = new Set([m.id]);
    let next = m.replacement;
    let hop = m; // the entry whose replacement is `next`: its second option and note belong to that target
    seen.add(next);
    while (byId.get(next)?.replacement && byId.get(next).qualifier !== "not-before" && !seen.has(byId.get(next).replacement)) {
      hop = byId.get(next);
      next = hop.replacement;
      seen.add(next);
    }
    if (next !== m.replacement && next !== m.id) {
      m.via = m.replacement; m.replacement = next;
      if (hop.replacement_alt) m.replacement_alt = hop.replacement_alt; else delete m.replacement_alt;
      if (hop.replacement_note) m.replacement_note = hop.replacement_note; else delete m.replacement_note;
    }
  }
  // Anthropic short names point at a dated snapshot: "claude-sonnet-4-5" and "-latest" -> claude-sonnet-4-5-20250929,
  // "claude-sonnet-4-0" -> claude-sonnet-4-20250514. The deprecation page lists only snapshots, so a short name
  // is added only when every snapshot behind it shares one date. Aliases go in the lookup, not in `models`.
  const groups = new Map();
  for (const m of byId.values()) {
    const base = m.provider === "anthropic" && m.id.match(/^(claude-.+)-\d{8}$/)?.[1];
    if (base) groups.set(base, [...(groups.get(base) || []), m]);
  }
  const lookup = new Map(byId);
  for (const [base, snaps] of groups) {
    if (snaps.some((s) => s.retires !== snaps[0].retires || s.qualifier !== snaps[0].qualifier)) continue;
    const latest = snaps.reduce((a, b) => (a.id > b.id ? a : b));
    const names = [base, `${base}-latest`, ...(/-[a-z]+-\d$/.test(base) ? [`${base}-0`] : [])];
    for (const n of names) if (!lookup.has(n)) lookup.set(n, { ...latest, aliasOf: latest.id });
  }
  // Cloud platforms with their own dates (data.platforms.bedrock, …). Kept outside `models` so older Driftline
  // versions, which accept only OpenAI/Anthropic/Google entries there, still read the live list.
  const platformModels = [];
  for (const [platform, p] of Object.entries(data.platforms || {})) {
    for (const pm of p?.models || []) {
      if (!pm?.id || !/^\d{4}-\d{2}-\d{2}$/.test(pm.retires || "")) continue;
      const e = { ...pm, provider: pm.maker, platform, platform_name: p.name || platform, platform_source: p.sources?.[pm.page] || p.source, qualifier: "exact" };
      if (p.direct) {
        // A provider's own API (Groq, Mistral, xAI, Cohere, DeepSeek). Distinctive IDs are found under their plain name;
        // ambiguous ones (a "/" — Groq's qwen/qwen3-32b is also an OpenRouter name — or a plain word like Cohere's
        // "command") only under "<provider>:<id>", used when the file shows that provider (see PROVIDER_SIGNS).
        const d = { ...e, ...(pm.routes ? { routes: true } : {}) };
        lookup.set(`${platform}:${pm.id}`, d);
        const ambiguous = pm.id.includes("/") || (!/\d/.test(pm.id) && !pm.id.startsWith(`${pm.maker}-`) && !pm.id.startsWith(`${platform}-`));
        if (!ambiguous && !lookup.has(pm.id)) lookup.set(pm.id, d);
        platformModels.push(d);
        continue;
      }
      if (platform === "azure") {
        // Azure uses OpenAI's (and other makers') model names, with its own date per model version. Entries live under
        // "azure:<id>" (earliest version: the one to plan for when the code doesn't say) and "azure:<id>@<version>".
        const current = (v) => /^(ga|preview|generally available)$/i.test(v?.lifecycle || "");
        const mk = (v, extra = {}) => ({ ...e, retires: v.retires, qualifier: current(v) ? "scheduled" : "exact", lifecycle: v.lifecycle,
          ...(v.replacement ? { replacement: v.replacement } : {}), ...extra });
        const base = mk(pm.versions?.[0] || pm, { replacement: pm.replacement });
        if (!base.replacement) delete base.replacement;
        lookup.set(`azure:${pm.id}`, base);
        for (const v of pm.versions || []) if (v.version) lookup.set(`azure:${pm.id}@${v.version}`, mk(v, { version: v.version }));
        // OpenAI's entry for the same model (o3 ↔ o3, gpt-4o-2024-05-13 ↔ gpt-4o version 2024-05-13) learns Azure's date.
        for (const twin of [byId.get(pm.id), ...(pm.versions || []).map((v) => byId.get(`${pm.id}-${v.version}`) && { m: byId.get(`${pm.id}-${v.version}`), v })]) {
          const m = twin?.m || twin, v = twin?.v || pm.versions?.[0];
          if (!m || !v || twin === undefined) continue;
          if (m.retires !== v.retires) m.azure = { retires: v.retires, ...(v.version ? { version: v.version } : {}), ...(v.replacement ? { replacement: v.replacement } : {}) };
        }
        platformModels.push(base);
        continue;
      }
      if (platform === "vertex") {
        // Vertex uses the Gemini API's and Anthropic's model names, with its own dates. Its entries live under
        // "vertex:<id>" and are used when the code shows it runs on Vertex (see resolveId).
        lookup.set(`vertex:${pm.id}`, e);
        // Plain name too, but only for names that exist nowhere else: -maas open models, "@version" IDs and partner
        // models other than Claude. A Gemini ID without an entry here may still run on the Gemini API (no date there).
        if (!lookup.has(pm.id) && (/-maas$|@/.test(pm.id) || !["google", "anthropic"].includes(pm.maker))) lookup.set(pm.id, e);
        // The Gemini API / Anthropic entry for the same model learns Vertex's date, so reports can mention it.
        // claude-3-5-sonnet-v2 → the newest claude-3-5-sonnet-YYYYMMDD snapshot.
        const twin = byId.get(pm.id) || (pm.maker === "anthropic" ? [...byId.values()].filter((m) => m.provider === "anthropic" && m.id.replace(/-\d{8}$/, "") === pm.id.replace(/-v\d+$/, "")).sort((a, b) => b.id.localeCompare(a.id))[0] : null);
        if (twin && twin.retires !== pm.retires) twin.vertex = { retires: pm.retires, ...(pm.replacement ? { replacement: pm.replacement } : {}) };
        // Vertex names no replacement for Claude: pass on Anthropic's, marked as such (as for Bedrock).
        if (pm.maker === "anthropic" && !pm.replacement && twin?.replacement) { e.replacement = twin.replacement; e.replacement_from = "anthropic"; }
        platformModels.push(e);
        continue;
      }
      // The platform names no replacement. For Claude, pass on Anthropic's, marked as such: its ID on the platform differs.
      const base = pm.maker === "anthropic" ? byId.get(pm.id.replace(/^anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "")) : null;
      if (base?.replacement) { e.replacement = base.replacement; e.replacement_from = "anthropic"; }
      lookup.set(pm.id, e);
      platformModels.push(e);
    }
  }
  for (const [k, v] of lookup) if (v.aliasOf && !v.vertex && byId.get(v.aliasOf)?.vertex) lookup.set(k, { ...v, vertex: byId.get(v.aliasOf).vertex });
  return { ...data, models: [...byId.values()], byId: lookup, platformModels };
}

// Bedrock's own model IDs: "<maker>.<model>", e.g. anthropic.claude-3-5-sonnet-20240620-v1:0 or meta.llama3-70b-instruct-v1:0.
export const BEDROCK_ID = /^(ai21|amazon|anthropic|cohere|deepseek|google|luma|meta|minimax|mistral|moonshot|moonshotai|nvidia|openai|qwen|stability|twelvelabs|writer|zai)\.[a-z0-9]/;
const PLATFORM_LABEL = { bedrock: "Amazon Bedrock", vertex: "Vertex AI", azure: "Azure", groq: "Groq", mistral: "Mistral AI", xai: "xAI", cohere: "Cohere", deepseek: "DeepSeek" };

// Signs in a file that it calls one of these providers' APIs (for their ambiguous model IDs).
export const PROVIDER_SIGNS = {
  groq: /\bgroq\b|GROQ_API_KEY|api\.groq\.com/i,
  cohere: /\bcohere\b|CO_API_KEY|COHERE_API_KEY|api\.cohere\.(?:ai|com)/i,
  mistral: /mistralai|MISTRAL_API_KEY|api\.mistral\.ai/i,
  xai: /api\.x\.ai|XAI_API_KEY|xai_sdk|@ai-sdk\/xai/i,
  deepseek: /deepseek/i,
};

// Signs in a file that its OpenAI (or other) model calls go through Microsoft Azure (Azure OpenAI / Foundry).
export const AZURE_SIGNS = /\bAzureOpenAI\b|AsyncAzureOpenAI|AzureChatOpenAI|AzureOpenAIEmbeddings|azure_endpoint|azure_deployment|openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com|AZURE_OPENAI|@azure\/openai|Azure\.AI\.OpenAI|azure-ai-inference|Microsoft\.CognitiveServices\/accounts\/deployments|azurerm_cognitive_deployment|api_type\s*[=:]\s*["']azure/;
// Model version next to a model name in an Azure file (deployment templates): version: '2024-08-06'. Not api_version.
const AZURE_VERSION = /(?<![\w-])(?:model[_-]?)?version["']?\s*[:=]\s*["']?([\w.-]+)["']?/i;
const API_VERSION = /api[_-]?version/i;

// Signs in a file that its Gemini/Claude calls go through Google Vertex AI rather than the Gemini API or Anthropic.
export const VERTEX_SIGNS = /\bvertexai\b|vertex_ai|google[.-]cloud[.-]aiplatform|@google-cloud\/vertexai|@ai-sdk\/google-vertex|aiplatform\.googleapis\.com|publishers\/(?:google|anthropic)\/models|GOOGLE_GENAI_USE_VERTEXAI|ChatVertexAI|AnthropicVertex|anthropic\.vertex|\bVertexAI\s*\(|vertexai\s*[=:]\s*(?:True|true)/;
// The ID itself says Vertex: a "vertex_ai/" prefix, a publishers/… resource path, Claude's "@date" spelling, a MaaS ID.
const vertexSpelling = (raw) => /^vertex_ai\/|publishers\/(?:google|anthropic)\/models\/|^claude-[\w.-]+@\d{8}$|-maas$/i.test(raw.trim());

// The registry key for an ID as written in code. With onVertex (file shows Vertex signs) or a Vertex spelling, a
// model Vertex lists is looked up as "vertex:<id>"; otherwise the plain ID (Gemini API / Anthropic dates).
export function resolveId(raw, registry, { onVertex = false, onAzure = false, version, providers } = {}) {
  const azureSpelled = /^azure\//i.test(raw.trim());
  const id = normalizeId(azureSpelled ? raw.trim().slice(6) : raw);
  if (onAzure || azureSpelled) {
    // gpt-4o-2024-08-06 → gpt-4o version 2024-08-06; a version found next to the name in the file wins.
    const snap = id.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/);
    const has = (k) => registry?.byId?.has(k);
    if (snap && has(`azure:${snap[1]}@${snap[2]}`)) return `azure:${snap[1]}@${snap[2]}`;
    if (version && has(`azure:${id}@${version}`)) return `azure:${id}@${version}`;
    if (has(`azure:${id}`)) return `azure:${id}`;
  }
  // Groq, Cohere, … : ambiguous IDs (qwen/qwen3-32b, command) count only in files that call that provider, or with a
  // "groq/" style prefix. The raw spelling is tried first: normalizeId strips "openai/" from Groq's openai/gpt-oss-120b.
  const lowerRaw = raw.trim().toLowerCase();
  for (const [p, on] of Object.entries(providers || {})) {
    const pre = lowerRaw.startsWith(`${p}/`) ? lowerRaw.slice(p.length + 1) : null;
    if (!on && pre === null) continue;
    for (const cand of [lowerRaw, pre, id].filter(Boolean)) if (registry?.byId?.has(`${p}:${cand}`)) return `${p}:${cand}`;
  }
  if (!onVertex && !vertexSpelling(raw)) return id;
  const lower = raw.trim().toLowerCase().replace(/^.*publishers\/(?:google|anthropic)\/models\//, "");
  // Claude on Vertex: claude-3-5-sonnet-v2@20241022 → claude-3-5-sonnet-v2; claude-3-haiku-20240307 → claude-3-haiku.
  const vid = /^claude-/.test(lower) ? lower.replace(/^vertex_ai\//, "").replace(/@\d{8}$/, "").replace(/-\d{8}$/, "") : id;
  return registry?.byId?.has(`vertex:${vid}`) ? `vertex:${vid}` : id;
}
// How a key is shown: "vertex:gemini-2.5-pro" → "gemini-2.5-pro (Vertex AI)".
export const shownId = (key) => String(key).startsWith("vertex:") ? `${String(key).slice(7)} (Vertex AI)`
  : String(key).startsWith("azure:") ? `${String(key).slice(6).replace("@", " ")} (Azure)`
  : /^(groq|mistral|xai|cohere|deepseek):/.test(key) ? `${String(key).replace(/^[a-z]+:/, "")} (${PLATFORM_LABEL[String(key).split(":")[0]]})` : key;
export { AZURE_VERSION, API_VERSION };

// For a Gemini API / Anthropic entry whose Vertex date differs: one sentence, so Vertex users see it too.
// (Also covers Azure: one sentence per platform whose date differs.)
export function vertexNote(entry, today = new Date()) {
  if (entry?.platform) return "";
  const iso = today.toISOString().slice(0, 10), out = [];
  if (entry?.vertex) { const v = entry.vertex; out.push(`On Vertex AI the date differs: ${v.retires <= iso ? "retired" : "retires"} ${v.retires}${v.replacement ? ` (Vertex names ${v.replacement})` : ""}.`); }
  if (entry?.azure) { const a = entry.azure; out.push(`On Azure the date differs: ${a.retires <= iso ? "retired" : "retires"} ${a.retires}${a.version ? ` (version ${a.version})` : ""}${a.replacement ? `; Azure names ${a.replacement}` : ""}.`); }
  return out.join(" ");
}
export const platformNotes = vertexNote;

// Extra sentence for models on a cloud platform: whose dates these are, regions that differ, extended-access pricing.
export function platformText(entry, today = new Date()) {
  if (!entry?.platform) return "";
  const name = entry.platform_name || PLATFORM_LABEL[entry.platform] || entry.platform;
  if (PROVIDER_SIGNS[entry.platform]) {
    const host = entry.platform === "groq" && entry.maker !== "groq";
    const parts = [host ? "Date set by Groq for its API (the model maker's own date can differ)" : `Date from ${name}'s own deprecation notes`];
    if (entry.note) parts.push(entry.note.replace(/^DeepSeek: /, ""));
    return parts.join("; ") + ".";
  }
  if (entry.platform === "azure") {
    const vs = entry.versions || [];
    const parts = [`Date set by Azure${entry.maker === "openai" ? " (OpenAI's own date can differ)" : ", not by the model maker"}`];
    if (!entry.version && vs.length > 1) parts.push(`it depends on the deployed version: ${vs.map((v) => `${v.version} → ${v.retires}`).join(", ")}; the version wasn't visible in the code, so the earliest is shown`);
    if (entry.qualifier === "scheduled") parts.push(`${entry.lifecycle || "current"} model: Azure plans every model's retirement ahead`);
    return parts.join("; ") + ".";
  }
  const parts = [entry.platform === "vertex" && ["google", "anthropic"].includes(entry.maker) ? `Date set by Vertex AI (${entry.maker === "google" ? "the Gemini API's" : "Anthropic's"} own date can differ)` : `Date set by ${name}, not by the model maker`];
  const regs = entry.regions || [];
  if (regs.length > 1) {
    const last = regs[regs.length - 1];
    const first = regs[0].regions.slice(0, 3).join(", ") + (regs[0].regions.length > 3 ? " …" : "");
    parts.push(`${entry.retires} is the earliest (${first}); other regions differ, the latest is ${last.retires} (${last.regions.slice(0, 2).join(", ")}${last.regions.length > 2 ? " …" : ""})`);
  }
  const iso = today.toISOString().slice(0, 10);
  if (entry.extended && entry.retires > iso) parts.push(entry.extended <= iso ? `in extended access since ${entry.extended}: the model maker may charge more` : `extended access from ${entry.extended}: the model maker may charge more`);
  return parts.join("; ") + ".";
}

// Strip prefixes people put in front of model IDs, e.g. "models/gemini-2.0-flash" or "openai/gpt-4",
// and map cloud-platform spellings to the provider's ID:
//   Amazon Bedrock  "us.anthropic.claude-3-5-sonnet-20240620-v1:0" -> "anthropic.claude-3-5-sonnet-20240620-v1:0" (Bedrock's own dates)
//   Google Vertex   "claude-3-5-sonnet@20240620"                     -> "claude-3-5-sonnet-20240620"
//   Bedrock ARN     "arn:aws:bedrock:...:foundation-model/anthropic.claude-..." -> "anthropic.claude-..."
//   Router prefixes "openrouter/openai/gpt-4", "vertex_ai/gemini-2.0-flash" -> plain ID (not azure/: Azure retires on its own dates)
export function normalizeId(raw) {
  let id = raw.trim().toLowerCase();
  if (id.startsWith("arn:aws:bedrock")) id = id.slice(id.lastIndexOf("/") + 1); // foundation-model/… or inference-profile/…
  let prev;
  do { prev = id; id = id.replace(/^(models|openai|anthropic|google|gemini|vertex_ai|bedrock|converse|invoke|openrouter)\//, ""); } while (id !== prev);
  // Amazon Bedrock sets its own dates ("only the dates on this page apply"), so its IDs stay as they are and are
  // looked up in the Bedrock list; a cross-region inference profile prefix (us., eu., global., …) is dropped.
  const profile = id.replace(/^(?:us|eu|apac|global|us-gov|jp|au|ca)\./, "");
  if (BEDROCK_ID.test(profile)) return profile;
  id = id.replace(/(?:-v\d+)?@(\d{8})$/, "-$1");     // Vertex: claude-3-5-sonnet-v2@20241022
  return id.startsWith("claude-") ? id.replace(/(\d)\.(\d)/g, "$1-$2") : id; // OpenRouter: claude-sonnet-4.5
}

// Is this string shaped like a model ID from one of the three providers?
// IDs listed in the registry (e.g. "whisper-1", "dall-e-3", "imagen-4.0-generate-001") always count.
export function looksLikeModelId(id, known) {
  if (known && known.has(id)) return true;
  return /^(gpt-\d|gpt-[a-z]|chatgpt-|o[1-9](-|$)|claude-|gemini-|text-embedding-|davinci-|babbage-)/.test(id);
}

// Only text models can be drift-tested; audio, image, video, embedding and the rest are scan-only.
export const isTextModel = (entry) => !entry?.kind || entry.kind === "text";

// The replacement as people should read it: the model, plus the provider's extra instruction when there is one,
// e.g. "gpt-6.1-sol (reasoning.mode: pro, in the Responses API)". Without the note, a rename alone is not the move.
export const replacementText = (entry) => entry?.replacement
  ? entry.replacement + (entry.replacement_alt ? ` or ${entry.replacement_alt}` : "") + (entry.replacement_note ? ` (${entry.replacement_note})` : "")
  : entry?.platform && entry.replacement_note ? entry.replacement_note : ""; // e.g. Cohere: "Cohere suggests x, y or z"

// The live list marks an entry under_review when the provider's page no longer matches it (found by the page check
// every 6 hours) and the registry hasn't been fixed yet. Say so instead of presenting the stored date as fact.
const WHO_NAME = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };
export function reviewText(entry) {
  const r = entry?.under_review;
  if (!r) return "";
  return `Under review: ${WHO_NAME[entry.provider] || entry.provider}'s page no longer matches the ${r.what || "entry"} shown here (since ${r.since}); Driftline is updating it. Check ${r.page || "the provider's deprecation page"} before acting on this ${r.what === "replacement" ? "replacement" : "date"}.`;
}

// Providers sometimes change the recommended replacement after announcing a retirement. The registry keeps
// the old one and the date we saw the change, so reports can say so instead of silently switching targets.
export const RECENT_CHANGE_DAYS = 120;
export function replacementChange(entry, today = new Date()) {
  if (!entry?.replacement_changed || !entry.previous_replacement) return null;
  const days = Math.floor((today - new Date(entry.replacement_changed + "T00:00:00Z")) / DAY);
  return days >= 0 && days <= RECENT_CHANGE_DAYS ? { on: entry.replacement_changed, was: entry.previous_replacement, days } : null;
}

/**
 * Classify one model ID against the registry on a given date.
 * status: retired | at-risk | deprecated | active | unknown
 */
export function classify(id, registry, { today = new Date(), warnDays = 90 } = {}) {
  const entry = registry.byId.get(id);
  if (!entry) return { id, status: "unknown" };
  const retires = new Date(entry.retires + "T00:00:00Z");
  const days = Math.ceil((retires - today) / DAY);
  let status;
  if (entry.qualifier === "not-before") status = "active";
  else if (days <= 0) status = entry.qualifier === "earliest" ? "at-risk" : "retired"; // Google only gives earliest dates
  else if (days <= warnDays) status = "at-risk";
  // Azure lists a planned date even for current (GA/Preview) models; far off, that isn't a deprecation.
  else status = entry.qualifier === "scheduled" ? "active" : "deprecated";
  return { id, status, days, entry };
}
