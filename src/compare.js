// Compares the current model's answer with the replacement model's answer.
// Scores run from 0 (nothing in common) to 1 (identical in substance).

const SAME = 0.9;
const CHANGED = 0.6;

function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
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
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try { return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }; } catch {}
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

/**
 * Returns { score, result, note } where result is: same | changed | broken
 */
export function compare(before, after, expect = "text") {
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
