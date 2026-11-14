// `driftline fix`: replaces retiring model IDs with their replacement where Driftline's migration rules say the move
// is a plain rename. Everything else is left alone and listed with the reason, so a person (or Pro's migration PR)
// handles it. Never touches documentation files. Keeps the spelling around the ID ("openai/gpt-4" → "openai/gpt-4.1").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanDirectory } from "./scan.js";
import { classify } from "./registry.js";
import { migrationFor, MIGRATION_LABEL } from "./migration.js";

const FLAGGED = new Set(["retired", "at-risk", "deprecated"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Why a finding can't be fixed by a rename, or null when it can.
function reason(f) {
  const e = f.entry;
  if (f.doc) return "documentation file (left as written)";
  if (!e.replacement) return e.replacement_note ? `no single replacement (${e.replacement_note})` : "the provider names no replacement";
  if (e.under_review) return "under review: the provider's page changed and Driftline is checking it";
  if (e.replacement_alt) return `the provider names two replacements (${e.replacement} or ${e.replacement_alt}): which one fits depends on how you use it`;
  if (e.platform === "bedrock" || e.replacement_from) return `on ${e.platform_name || e.platform} the replacement has its own model ID`;
  if (e.platform === "azure") return "on Azure the model is set by your deployment, not only by the name in code";
  const mig = migrationFor(e);
  if (!mig?.drop_in) return `more than a rename: ${MIGRATION_LABEL[mig?.change] || "see the report"}${mig?.note ? ` (${mig.note})` : ""}`;
  return null;
}

// The new spelling: the replacement in place of the model ID at the end of what's written ("models/x", "openai/x").
function rewrite(raw, plain, replacement) {
  if (!raw || !plain) return null;
  return raw.toLowerCase().endsWith(plain.toLowerCase()) ? raw.slice(0, raw.length - plain.length) + replacement : null;
}

export function planFixes(root, registry, { today = new Date(), warnDays = 90 } = {}) {
  const hits = scanDirectory(root, { known: registry.byId });
  const changes = [], skipped = [];
  for (const h of hits) {
    const c = classify(h.id, registry, { today, warnDays });
    if (!c.entry || !FLAGGED.has(c.status)) continue;
    const f = { ...h, ...c, id: h.id };
    const plain = h.id.replace(/^[a-z]+:/, "").replace(/@.*$/, ""); // registry key → the ID as providers write it
    const why = reason(f);
    const to = why ? null : rewrite(h.raw, plain, f.entry.replacement);
    if (why || !to) { skipped.push({ file: h.file, line: h.line, id: plain, status: c.status, reason: why || `written as "${h.raw}", which Driftline won't rewrite automatically` }); continue; }
    changes.push({ file: h.file, line: h.line, id: plain, from: h.raw, to, status: c.status, retires: f.entry.retires });
  }
  // One change per spelling per line (the same ID twice on a line is one replacement).
  const seen = new Set();
  return { changes: changes.filter((c) => { const k = `${c.file}:${c.line}:${c.from}`; if (seen.has(k)) return false; seen.add(k); return true; }), skipped };
}

// Rewrites the planned lines in place. Only whole IDs are replaced: "gpt-4" in "gpt-4o" is left alone.
export function applyFixes(root, changes) {
  const byFile = new Map();
  for (const c of changes) (byFile.get(c.file) || byFile.set(c.file, []).get(c.file)).push(c);
  let applied = 0;
  for (const [file, list] of byFile) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n"); // keeps "\r" on Windows line endings
    for (const c of list) {
      const re = new RegExp(`(?<![\\w.\\-/:@])${esc(c.from)}(?![\\w.\\-:@])`, "g");
      const before = lines[c.line - 1];
      if (before === undefined) continue;
      lines[c.line - 1] = before.replace(re, c.to);
      if (lines[c.line - 1] !== before) applied++;
    }
    const out = lines.join("\n");
    if (out !== text) writeFileSync(path, out);
  }
  return applied;
}

export function fixReport({ changes, skipped }, { dryRun }) {
  const out = [];
  if (!changes.length && !skipped.length) return "Nothing to fix: no retired or retiring model IDs found.";
  if (changes.length) {
    out.push(dryRun ? `Would change ${changes.length} line${changes.length === 1 ? "" : "s"} (dry run, nothing written):` : `Changed ${changes.length} line${changes.length === 1 ? "" : "s"}:`);
    for (const c of changes) out.push(`  ${c.file}:${c.line}  ${c.from} → ${c.to}  (${c.status === "retired" ? "retired" : "retires"} ${c.retires})`);
  }
  if (skipped.length) {
    out.push("", `Left for you (${skipped.length}):`);
    for (const s of skipped) out.push(`  ${s.file}:${s.line}  ${s.id}: ${s.reason}`);
  }
  out.push("", changes.length && !dryRun
    ? "A rename keeps the call working, but answers can still change: test your prompts on the new model before you ship (Driftline Pro runs them for you: https://aidriftline.com/#drift)."
    : "Run without --dry-run to apply the changes.");
  if (!changes.length) out.pop();
  return out.join("\n");
}
