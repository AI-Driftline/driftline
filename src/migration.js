// Is the replacement a drop-in, or does moving to it need more than a new model name?
// Rules per model family, written from the providers' own migration docs (checked 13 Nov 2026).
// Anything no rule matches is a plain rename, which is how Driftline has always presented it.
//
// migrationFor(entry) → { change, drop_in, note, guide }
//   change: "rename"   the model name is the only change
//           "settings" also set a parameter the provider names (e.g. reasoning.mode: pro)
//           "params"   some request parameters are removed or renamed
//           "api"      a different API, method or endpoint
//           "re-embed" stored embeddings have to be recomputed
//           "choose"   the provider names more than one replacement; which one depends on how you use it

const OPENAI = "https://developers.openai.com/api/docs/guides/";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/";

// Claude family version from an ID: claude-sonnet-4-5-20250929 → 4.5, claude-3-haiku-20240307 → 3, claude-opus-4-8 → 4.8
function claudeVersion(id) {
  const m = String(id || "").match(/^claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(\d+)(?:[-.](\d))?(?:-|$)/);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : null;
}
const geminiMajor = (id) => { const m = String(id || "").match(/^gemini-(\d+)/); return m ? Number(m[1]) : null; };

const RULES = [
  {
    when: (e) => e.provider === "openai" && (/^(davinci-002|babbage-002|gpt-3\.5-turbo-instruct)/.test(e.id) || /-completions$/.test(e.id)),
    change: "api",
    note: "The old Completions endpoint (a plain prompt) doesn't serve the replacement: move the call to the Responses API or Chat Completions (messages).",
    guide: OPENAI + "migrate-to-responses",
  },
  {
    when: (e) => e.provider === "openai" && /^(tts-1|gpt-4o-mini-tts)/.test(e.id),
    change: "api",
    note: "OpenAI calls this a change of API workflow: the replacement isn't a model for /v1/audio/speech and runs through the Realtime API.",
    guide: OPENAI + "text-to-speech",
  },
  {
    when: (e) => e.provider === "openai" && /realtime-preview/.test(e.id),
    change: "api",
    note: "The preview models ran on the Realtime beta (header OpenAI-Beta: realtime=v1), which OpenAI shut down; the replacement needs the current Realtime API.",
    guide: OPENAI + "realtime",
  },
  {
    when: (e) => e.provider === "openai" && /^(whisper-1|gpt-4o(-mini)?-transcribe)/.test(e.id),
    change: "choose",
    note: "OpenAI names two replacements: gpt-transcribe for recorded files, gpt-live-transcribe for live audio. Word timestamps, subtitles and translation work differently, so check those if you use them.",
    guide: OPENAI + "transcription",
  },
  {
    when: (e) => e.provider === "openai" && e.kind === "image" && /-sunburst$/.test(e.replacement || ""),
    change: "rename",
    note: "Same Images API. OpenAI offers two: …-sunburst for editing precision, …-flare for fast everyday generation.",
    guide: OPENAI + "image-generation",
  },
  {
    when: (e) => e.kind === "embedding",
    change: "re-embed",
    note: "Embeddings from different models can't be compared: re-embed your stored data with the new model, and query with that same model. The vector size may differ too.",
    guide: (e) => e.provider === "google" ? GOOGLE + "embeddings" : OPENAI + "embeddings",
  },
  {
    when: (e) => e.provider === "google" && /^imagen-/.test(e.id),
    change: "api",
    note: "Use generate_content instead of generate_images; images come back as content parts, not an image response object.",
    guide: GOOGLE + "imagen",
  },
  {
    when: (e) => e.provider === "google" && /^veo-/.test(e.id),
    change: "api",
    note: "Gemini Omni Flash uses the Interactions API (interactions.create), not Veo's video-generation call. Google also offers Veo itself on Gemini Enterprise Agent Platform.",
    guide: GOOGLE + "video",
  },
  {
    when: (e) => e.provider === "google" && (!e.kind || e.kind === "text") && geminiMajor(e.id) === 2 && geminiMajor(e.replacement) >= 3,
    change: "params",
    note: "Gemini 3 changes the request: remove temperature, top_p, top_k, candidate_count and prefilled model turns, replace thinking_budget with thinking_level, and check function calling.",
    guide: (e) => GOOGLE + (/^gemini-3\.8/.test(e.replacement) ? "whats-new-gemini-3.8" : "whats-new-gemini-3.6"),
  },
  {
    when: (e) => e.provider === "anthropic" && claudeVersion(e.id) !== null && claudeVersion(e.id) < 4.7 && claudeVersion(e.replacement) >= 4.7,
    change: "params",
    note: "Claude 4.7 and later accept only the default temperature, top_p and top_k: if your code sets them, remove them.",
    guide: "https://platform.claude.com/docs/en/api/migration-2026-10-21",
  },
];

export function migrationFor(entry) {
  if (!entry?.replacement) return null;
  // On a cloud platform the replacement has a different model ID there (and may not be offered in every region).
  if (entry.platform && entry.replacement_from) return { change: "platform", drop_in: false, note: `${entry.platform_name || entry.platform} names no replacement. ${entry.replacement} is Anthropic's; look up its ${entry.platform_name || entry.platform} model ID and check it is offered in your region.`, guide: entry.platform_source || null };
  // A provider's own instruction next to the replacement (registry replacement_note) comes first.
  const setting = entry.replacement_note
    ? { change: "settings", drop_in: false, note: `Also set ${entry.replacement_note}.`, guide: /reasoning\.mode/.test(entry.replacement_note) ? OPENAI + "reasoning" : null }
    : null;
  const rule = RULES.find((r) => r.when(entry));
  if (!rule) return setting || { change: "rename", drop_in: true, note: "", guide: null };
  const found = { change: rule.change, drop_in: rule.change === "rename", note: rule.note, guide: typeof rule.guide === "function" ? rule.guide(entry) : rule.guide };
  return setting ? { ...found, change: found.change === "rename" ? "settings" : found.change, drop_in: false, note: `${setting.note} ${found.note}` } : found;
}

// Short label for tables: "Rename" or what else is needed.
export const MIGRATION_LABEL = {
  rename: "Rename", settings: "Rename + setting", platform: "New platform ID", params: "Parameter changes", api: "API change", "re-embed": "Re-embed data", choose: "Pick one of two",
};
