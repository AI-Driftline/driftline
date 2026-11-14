import { replacementChange, reviewText, platformText, vertexNote } from "./registry.js";
import { migrationFor, MIGRATION_LABEL } from "./migration.js";

const STATUS_LABEL = {
  retired: "🔴 Retired",
  "at-risk": "🟠 Retires soon",
  deprecated: "🟡 Deprecated",
  active: "🟢 Active",
  unknown: "⚪ No retirement listed",
};
const RESULT_LABEL = { same: "✅ Same", changed: "🟡 Changed", broken: "🔴 Broken", error: "⚠️ Error", skipped: "⏭️ Skipped" };

// "<br>changed 2026-11-13, was `gpt-5.6-sol`" when the provider changed its advice recently.
const changed = (entry, today) => { const c = replacementChange(entry, today); return c ? `<br>_changed ${c.on}, was ${code(c.was)}_` : ""; };

// Google gives only earliest dates; once one has passed the model may be gone already, so "retires soon" would be wrong.
// Routed models keep answering after the date, but from the replacement model ("retired" would be wrong too).
const label = (c) => c.status === "at-risk" && c.entry?.qualifier === "earliest" && c.days <= 0
  ? "🟠 May already be off"
  : c.status === "retired" && c.entry?.routes ? "🔴 Now answered by the replacement"
  : c.status === "at-risk" && c.entry?.routes ? "🟠 Switches model soon"
  : STATUS_LABEL[c.status];

function when(c) {
  if (!c.entry) return "";
  const q = c.entry.routes ? " (routing starts)" : c.entry.qualifier === "earliest" ? " (earliest)" : c.entry.qualifier === "not-before" ? " (not before)" : "";
  const rel = c.days <= 0
    ? (c.entry.qualifier === "earliest" ? `earliest shutdown passed ${-c.days} days ago` : `${-c.days} days ago`)
    : `in ${c.days} days`;
  return `${c.entry.retires}${q} · ${rel}`;
}

// Table cells: no pipes, no line breaks, no raw HTML (provider error pages, odd file names).
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
// Inside a code span HTML is shown as text, so only pipes, line breaks and backticks need handling.
const code = (s) => `\`${String(s ?? "").replace(/[\r\n]+/g, " ").replace(/`/g, "'").replace(/\|/g, "\\|")}\``;

// A code fence longer than any run of backticks inside the text, so a model's own ```json fence can't close it.
function fenced(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, text, fence];
}

// GitHub issues hold at most 65,536 characters; keep the report well under that.
const MAX_REPORT = 60000;
const MAX_ANSWER = 1500;
const MAX_ROWS = 150;
const clip = (s) => { s = String(s || ""); return s.length > MAX_ANSWER ? s.slice(0, MAX_ANSWER) + "\n[…cut]" : s; };

export function renderReport({ findings, drift, registry, notices = [], answers = true, today = new Date() }) {
  const lines = ["## Driftline report", ""];
  const flagged = findings.filter((f) => ["retired", "at-risk", "deprecated"].includes(f.status));
  const byModel = new Map();
  for (const f of findings) {
    if (!byModel.has(f.id)) byModel.set(f.id, { ...f, places: [], docs: 0 });
    byModel.get(f.id).places.push(code(`${f.file}:${f.line}`));
    if (f.doc) byModel.get(f.id).docs++;
  }

  if (!findings.length) {
    lines.push("No AI model IDs found in this repository.");
  } else {
    const n = flagged.length;
    lines.push(n
      ? `**${n} reference${n === 1 ? "" : "s"} to retired or retiring models** across ${byModel.size} model ID${byModel.size === 1 ? "" : "s"} found.`
      : `Found ${byModel.size} model ID${byModel.size === 1 ? "" : "s"}. None are scheduled for retirement.`);
    lines.push("", "| Model | Status | Retirement | Replacement | Change needed | Where |", "|---|---|---|---|---|---|");
    const migNotes = new Map(); // note → { n, ids, guide } for the list under the table
    const underReview = []; // rows whose provider page changed and the registry isn't fixed yet
    const order = ["retired", "at-risk", "deprecated", "active", "unknown"];
    const all = [...byModel.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const rows = all.slice(0, MAX_ROWS); // flagged models sort first, so only unknown/active rows get cut
    for (const r of rows) {
      const mig = migrationFor(r.entry);
      let changeCell = "";
      if (mig) {
        if (mig.note && !(mig.change === "settings" && r.entry.replacement_note && mig.note === `Also set ${r.entry.replacement_note}.`)) {
          if (!migNotes.has(mig.note)) migNotes.set(mig.note, { n: migNotes.size + 1, ids: [], guide: mig.guide });
          migNotes.get(mig.note).ids.push(r.id);
          changeCell = `${mig.drop_in ? "✅" : "⚠️"} ${MIGRATION_LABEL[mig.change]} [${migNotes.get(mig.note).n}]`;
        } else changeCell = `${mig.drop_in ? "✅" : "⚠️"} ${MIGRATION_LABEL[mig.change]}`;
      }
      const places = r.places.slice(0, 3).join(", ") + (r.places.length > 3 ? ` +${r.places.length - 3} more` : "");
      const docsOnly = r.places.length && byModel.get(r.id).docs === r.places.length ? " · docs only" : "";
      if (r.entry?.under_review) underReview.push(r);
      lines.push(`| ${code(r.id)}${r.entry?.aliasOf ? " · alias of " + code(r.entry.aliasOf) : ""}${r.entry?.kind && r.entry.kind !== "text" ? " · " + r.entry.kind : ""} | ${label(r)}${docsOnly}${r.entry?.under_review ? " · 🔍 under review" : ""} | ${esc(when(r))} | ${r.entry?.replacement ? code(r.entry.replacement) + (r.entry.replacement_alt ? " or " + code(r.entry.replacement_alt) : "") + (r.entry.replacement_note ? " (" + esc(r.entry.replacement_note) + ")" : "") + changed(r.entry, today) : r.entry?.replacement_note ? esc(r.entry.replacement_note) : ""} | ${changeCell} | ${places} |`);
    }
    if (all.length > rows.length) lines.push("", `_${all.length - rows.length} more model ID(s) with no retirement listed are not shown._`);
    const onPlatform = rows.filter((r) => r.entry?.platform && ["retired", "at-risk", "deprecated"].includes(r.status));
    if (onPlatform.length) {
      lines.push("", "**Where these dates come from:**", "");
      for (const r of onPlatform) lines.push(`- ${code(r.id)}: ${esc(platformText(r.entry, today))}`);
    }
    // Gemini API / Anthropic dates were used (no Vertex signs in the file), but Vertex's date differs: say so.
    const vertexDiffers = rows.filter((r) => !r.entry?.platform && (r.entry?.vertex || r.entry?.azure));
    if (vertexDiffers.length) {
      lines.push("", "**If you call these through Vertex AI or Azure:**", "");
      for (const r of vertexDiffers) lines.push(`- ${code(r.id)}: ${esc(vertexNote(r.entry, today))}`);
    }
    if (underReview.length) {
      lines.push("", "**🔍 Under review:**", "");
      for (const r of underReview) lines.push(`- ${code(r.id)}: ${esc(reviewText(r.entry))}`);
    }
    if (migNotes.size) {
      lines.push("", "**More than a rename:**", "");
      for (const [note, m] of migNotes) lines.push(`${m.n}. ${m.ids.map(code).join(", ")}: ${esc(note)}${m.guide ? ` ([provider guide](${m.guide}))` : ""}`);
    }
  }

  if (drift?.length) {
    lines.push("", "### Drift test", "", "| Prompt | Current → replacement | Similarity | Result | Note |", "|---|---|---|---|---|");
    for (const d of drift) {
      const score = typeof d.score === "number" ? d.score.toFixed(2) : "";
      lines.push(`| ${esc(d.id)} | ${code(d.from)} → ${code(d.to)} | ${score} | ${RESULT_LABEL[d.result] || d.result} | ${esc(d.note)} |`);
    }
    const details = drift.filter((d) => d.before !== undefined);
    if (details.length && !answers) {
      lines.push("", "_Answers are not included here. They are in the job summary of the workflow run._");
    } else if (details.length) {
      lines.push("", "<details><summary>Answers</summary>", "");
      let shown = 0;
      for (const d of details) {
        const block = [`#### ${esc(d.id)}`, "", code(d.from), "", ...fenced(clip(d.before)), "", code(d.to), "", ...fenced(clip(d.after)), ""];
        if (lines.join("\n").length + block.join("\n").length > MAX_REPORT - 2000) break;
        lines.push(...block);
        shown++;
      }
      if (shown < details.length) lines.push(`_${details.length - shown} more answer(s) left out to stay within GitHub's size limit._`, "");
      lines.push("</details>");
    }
  }

  if (notices.length) lines.push("", ...notices.map((n) => `> ${n}`));
  lines.push("", `<sub>Retirement dates checked against official provider pages on ${registry.checked}${registry.source === "live" ? " (live list at aidriftline.com)" : ({ newer: " (list bundled with this version, newer than the live list)", unreachable: " (list bundled with this version; the live list could not be read)", offline: " (list bundled with this version)" })[registry.sourceWhy] || ""}. ` +
    `Sources: [OpenAI](${registry.sources.openai}) · [Anthropic](${registry.sources.anthropic}) · [Google](${registry.sources.google})${registry.platforms?.bedrock ? ` · [Amazon Bedrock](${registry.platforms.bedrock.source})` : ""}${registry.platforms?.vertex ? ` · [Vertex AI](${registry.platforms.vertex.source})` : ""}${registry.platforms?.azure ? ` · [Azure](${registry.platforms.azure.source})` : ""}.</sub>`);
  return lines.join("\n");
}
