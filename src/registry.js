import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

export function loadRegistry(path = join(here, "..", "registry", "models.json")) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(data.models.map((m) => [m.id, m]));
  return { ...data, byId };
}

// Strip prefixes people put in front of model IDs, e.g. "models/gemini-2.0-flash" or "openai/gpt-4".
export function normalizeId(raw) {
  return raw.trim().replace(/^(models|openai|anthropic|google|gemini)\//i, "").toLowerCase();
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
