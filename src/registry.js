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
  return { ...data, models: [...byId.values()], byId: lookup };
}

// Strip prefixes people put in front of model IDs, e.g. "models/gemini-2.0-flash" or "openai/gpt-4",
// and map cloud-platform spellings to the provider's ID:
//   Amazon Bedrock  "us.anthropic.claude-3-5-sonnet-20240620-v1:0" -> "claude-3-5-sonnet-20240620"
//   Google Vertex   "claude-3-5-sonnet@20240620"                     -> "claude-3-5-sonnet-20240620"
//   Bedrock ARN     "arn:aws:bedrock:...:foundation-model/anthropic.claude-..." -> "claude-..."
//   Router prefixes "openrouter/openai/gpt-4", "vertex_ai/gemini-2.0-flash" -> plain ID (not azure/: Azure retires on its own dates)
export function normalizeId(raw) {
  let id = raw.trim().toLowerCase();
  if (id.startsWith("arn:aws:bedrock")) id = id.slice(id.lastIndexOf("/") + 1); // foundation-model/… or inference-profile/…
  let prev;
  do { prev = id; id = id.replace(/^(models|openai|anthropic|google|gemini|vertex_ai|bedrock|openrouter)\//, ""); } while (id !== prev);
  const bedrock = /^(?:(?:us|eu|apac|global)\.)?anthropic\./;
  if (bedrock.test(id)) id = id.replace(bedrock, "").replace(/-v\d+(?::\d+)?$/, "");
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
  ? entry.replacement + (entry.replacement_alt ? ` or ${entry.replacement_alt}` : "") + (entry.replacement_note ? ` (${entry.replacement_note})` : "") : "";

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
  else status = "deprecated";
  return { id, status, days, entry };
}
