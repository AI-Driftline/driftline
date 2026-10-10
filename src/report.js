const STATUS_LABEL = {
  retired: "🔴 Retired",
  "at-risk": "🟠 Retires soon",
  deprecated: "🟡 Deprecated",
  active: "🟢 Active",
  unknown: "⚪ No retirement listed",
};
const RESULT_LABEL = { same: "✅ Same", changed: "🟡 Changed", broken: "🔴 Broken", error: "⚠️ Error", skipped: "⏭️ Skipped" };

function when(c) {
  if (!c.entry) return "";
  const q = c.entry.qualifier === "earliest" ? " (earliest)" : c.entry.qualifier === "not-before" ? " (not before)" : "";
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

export function renderReport({ findings, drift, registry, notices = [], answers = true }) {
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
    lines.push("", "| Model | Status | Retirement | Replacement | Where |", "|---|---|---|---|---|");
    const order = ["retired", "at-risk", "deprecated", "active", "unknown"];
    const all = [...byModel.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const rows = all.slice(0, MAX_ROWS); // flagged models sort first, so only unknown/active rows get cut
    for (const r of rows) {
      const places = r.places.slice(0, 3).join(", ") + (r.places.length > 3 ? ` +${r.places.length - 3} more` : "");
      const docsOnly = r.places.length && byModel.get(r.id).docs === r.places.length ? " · docs only" : "";
      lines.push(`| ${code(r.id)}${r.entry?.kind && r.entry.kind !== "text" ? " · " + r.entry.kind : ""} | ${STATUS_LABEL[r.status]}${docsOnly} | ${esc(when(r))} | ${r.entry?.replacement ? code(r.entry.replacement) : ""} | ${places} |`);
    }
    if (all.length > rows.length) lines.push("", `_${all.length - rows.length} more model ID(s) with no retirement listed are not shown._`);
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
  lines.push("", `<sub>Retirement dates checked against official provider pages on ${registry.checked}. ` +
    `Sources: [OpenAI](${registry.sources.openai}) · [Anthropic](${registry.sources.anthropic}) · [Google](${registry.sources.google}).</sub>`);
  return lines.join("\n");
}
