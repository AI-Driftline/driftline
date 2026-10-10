import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

export function loadRegistry(path = join(here, "..", "registry", "models.json")) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(data.models.map((m) => [m.id, { ...m }]));
  // Providers sometimes name a replacement that is itself being retired (o1-mini -> o4-mini -> ...).
  // Follow the chain so customers are pointed at a model that stays.
  for (const m of byId.values()) {
    if (!m.replacement) continue;
    const seen = new Set([m.id]);
    let next = m.replacement;
    seen.add(next);
    while (byId.get(next)?.replacement && byId.get(next).qualifier !== "not-before" && !seen.has(byId.get(next).replacement)) {
      next = byId.get(next).replacement;
      seen.add(next);
    }
    if (next !== m.replacement && next !== m.id) { m.via = m.replacement; m.replacement = next; }
  }
  return { ...data, models: [...byId.values()], byId };
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
  return id.replace(/(?:-v\d+)?@(\d{8})$/, "-$1");   // Vertex: claude-3-5-sonnet-v2@20241022
}

// Is this string shaped like a model ID from one of the three providers?
// IDs listed in the registry (e.g. "whisper-1", "dall-e-3", "imagen-4.0-generate-001") always count.
export function looksLikeModelId(id, known) {
  if (known && known.has(id)) return true;
  return /^(gpt-\d|gpt-[a-z]|chatgpt-|o[1-9](-|$)|claude-|gemini-|text-embedding-|davinci-|babbage-)/.test(id);
}

// Only text models can be drift-tested; audio, image, video, embedding and the rest are scan-only.
export const isTextModel = (entry) => !entry?.kind || entry.kind === "text";

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
