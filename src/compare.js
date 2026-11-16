// Compares the current model's answer with the replacement model's answer.
// Scores run from 0 (nothing in common) to 1 (identical in substance).

const SAME = 0.9;
const CHANGED = 0.6;

// Words, except in scripts written without spaces (Chinese, Japanese, Thai), where each character
// is a token; the word-pair pass below then compares them as character pairs.
const NO_SPACES = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Thai}";
const TOKEN = new RegExp(`[${NO_SPACES}]|(?:(?![${NO_SPACES}])[\\p{L}\\p{N}])+`, "gu");

function tokens(text) {
  return text.toLowerCase().match(TOKEN) || [];
}

function vector(text) {
  const t = tokens(text);
  const v = new Map();
  const add = (k) => v.set(k, (v.get(k) || 0) + 1);
  t.forEach((w, i) => { add(w); if (i > 0) add(t[i - 1] + " " + w); });
  return v;
}

export function textSimilarity(a, b) {
  if (a.trim() === b.trim()) return 1;
  const va = vector(a), vb = vector(b);
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of va) { na += x * x; if (vb.has(k)) dot += x * vb.get(k); }
  for (const [, y] of vb) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Models often wrap JSON in ```json fences or a sentence; pull out the JSON part.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return { ok: true, value: JSON.parse(candidate) }; } catch {}
  // JSON after a sentence, which may itself contain braces: try each opening bracket in turn.
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  let tries = 0;
  for (let start = candidate.search(/[[{]/); start >= 0 && start < end && tries < 50; tries++) {
    try { return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }; } catch {}
    const next = candidate.slice(start + 1).search(/[[{]/);
    start = next < 0 ? -1 : start + 1 + next;
  }
  return { ok: false };
}

function paths(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.slice(0, 20).map((v, i) => [String(i), v]) : Object.entries(value);
    if (!entries.length) out.set(prefix || "$", JSON.stringify(value));
    for (const [k, v] of entries) paths(v, Array.isArray(value) ? `${prefix}[]` : `${prefix}.${k}`, out);
  } else {
    out.set(prefix || "$", String(value).trim().toLowerCase());
  }
  return out;
}

export function jsonSimilarity(a, b) {
  const pa = paths(a), pb = paths(b);
  const keys = new Set([...pa.keys(), ...pb.keys()]);
  if (!keys.size) return 1;
  let score = 0;
  for (const k of keys) {
    if (pa.has(k) && pb.has(k)) score += pa.get(k) === pb.get(k) ? 1 : 0.5; // same field, different value
  }
  return score / keys.size;
}

// English words that flip a sentence's meaning. Word overlap barely notices one extra "not", so an answer that gains
// or loses one can't count as the same.
const NEGATION = /\b(?:not|no|never|cannot|none|nothing|nobody|neither|nor|without)\b|n['’]t\b/g;
const negations = (text) => (String(text).toLowerCase().match(NEGATION) || []).length;

const phrase = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function field(value, path) {
  let v = value;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object" || !(k in v)) return { found: false };
    v = v[k];
  }
  return { found: true, value: v && typeof v === "object" ? JSON.stringify(v) : String(v).trim().toLowerCase() };
}

/**
 * The prompt's own checks on one answer. `before` is the current model's answer, needed only for same_fields.
 * Returns a list of failures, each { key, note }; `key` identifies the check so both models' failures can be matched.
 */
export function runChecks(answer, checks = {}, { expect = "text", before } = {}) {
  const text = phrase(answer);
  const fails = [];
  for (const p of checks.must_include || []) if (!text.includes(phrase(p))) fails.push({ key: `+${p}`, note: `missing "${p}"` });
  for (const p of checks.must_not_include || []) if (text.includes(phrase(p))) fails.push({ key: `-${p}`, note: `says "${p}"` });
  if (checks.same_fields?.length && expect === "json" && before !== undefined) {
    const a = extractJson(before), b = extractJson(answer);
    for (const f of checks.same_fields) {
      const was = a.ok ? field(a.value, f) : { found: false };
      const now = b.ok ? field(b.value, f) : { found: false };
      if (!was.found) fails.push({ key: `=${f}`, note: `${f} missing in the current answer`, before: true });
      else if (!now.found) fails.push({ key: `=${f}`, note: `${f} missing` });
      else if (was.value !== now.value) fails.push({ key: `=${f}`, note: `${f}: ${clipValue(was.value)} → ${clipValue(now.value)}` });
    }
  }
  return fails;
}

const clipValue = (v) => (v.length > 40 ? v.slice(0, 40) + "…" : v);

export const hasChecks = (c = {}) => Boolean(c.must_include?.length || c.must_not_include?.length || c.same_fields?.length);

const RANK = { same: 0, changed: 1, broken: 2 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
const joinNotes = (...notes) => notes.filter(Boolean).join("; ");

/**
 * Returns { score, result, note, checked } where result is: same | changed | broken (or error).
 * `checks` holds the prompt's must_include, must_not_include and same_fields. They can only make a result worse:
 * a check the replacement fails is broken; one the current model fails too is a change to review, not drift.
 */
export function compare(before, after, expect = "text", checks = {}) {
  const base = similarity(before, after, expect);
  const checked = hasChecks(checks);
  if (base.result === "error") return { ...base, checked };
  let { result, note } = base;
  if (expect !== "json" && result === "same" && negations(before) !== negations(after)) {
    result = "changed";
    note = joinNotes(note, "One answer says \"not\" (or no, never, cannot) where the other doesn't; check the meaning");
  }
  if (checked && String(after ?? "").trim()) {
    const now = runChecks(after, checks, { expect, before });
    const was = new Set(runChecks(before, checks, { expect }).map((f) => f.key));
    const shared = now.filter((f) => f.before || was.has(f.key));
    const fresh = now.filter((f) => !f.before && !was.has(f.key));
    if (fresh.length) { result = "broken"; note = joinNotes(note, `Failed check: ${fresh.map((f) => f.note).join(", ")}`); }
    if (shared.length) {
      result = worse(result, "changed");
      note = joinNotes(note, `Current model fails this check too: ${shared.map((f) => f.note).join(", ")}`);
    }
  }
  return { score: base.score, result, note, checked };
}

function similarity(before, after, expect) {
  const emptyBefore = !String(before ?? "").trim(), emptyAfter = !String(after ?? "").trim();
  if (emptyBefore && emptyAfter) return { score: 0, result: "error", note: "Both models returned an empty answer" };
  if (emptyAfter) return { score: 0, result: "broken", note: "Replacement returned an empty answer" };
  if (emptyBefore) return { score: 0, result: "changed", note: "Current model returned an empty answer; review the replacement's" };
  if (expect === "json") {
    const a = extractJson(before), b = extractJson(after);
    if (!b.ok) return { score: 0, result: "broken", note: "Replacement did not return valid JSON" };
    if (!a.ok) return { score: 0.5, result: "changed", note: "Current model did not return valid JSON; replacement did" };
    const score = jsonSimilarity(a.value, b.value);
    return { score, result: label(score), note: score < 1 ? "JSON fields or values differ" : "" };
  }
  const score = textSimilarity(before, after);
  return { score, result: label(score), note: "" };
}

function label(score) {
  return score >= SAME ? "same" : score >= CHANGED ? "changed" : "broken";
}
