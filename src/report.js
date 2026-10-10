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

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport({ findings, drift, registry, notices = [] }) {
  const lines = ["## Driftline report", ""];
  const flagged = findings.filter((f) => ["retired", "at-risk", "deprecated"].includes(f.status));
  const byModel = new Map();
  for (const f of findings) {
    if (!byModel.has(f.id)) byModel.set(f.id, { ...f, places: [] });
    byModel.get(f.id).places.push(`\`${f.file}:${f.line}\``);
  }

  if (!findings.length) {
    lines.push("No AI model IDs found in this repository.");
  } else {
    const n = flagged.length;
    lines.push(n
      ? `**${n} reference${n === 1 ? "" : "s"} to retired or retiring models** across ${byModel.size} model ID${byModel.size === 1 ? "" : "s"} found.`
      : `Found ${byModel.size} model ID${byModel.size === 1 ? "" : "s"}. None are scheduled for retirement.`);
    lines.push("", "| Model | Status | Retirement | Replacement | Where |", "|---|---|---|---|---|");
    const order = ["retired", "at-risk", "deprecated", "unknown", "active"];
    const rows = [...byModel.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    for (const r of rows) {
      const places = r.places.slice(0, 3).join(", ") + (r.places.length > 3 ? ` +${r.places.length - 3} more` : "");
      lines.push(`| \`${esc(r.id)}\`${r.entry?.kind && r.entry.kind !== "text" ? " · " + r.entry.kind : ""} | ${STATUS_LABEL[r.status]} | ${esc(when(r))} | ${r.entry?.replacement ? "`" + esc(r.entry.replacement) + "`" : ""} | ${places} |`);
    }
  }

  if (drift?.length) {
    lines.push("", "### Drift test", "", "| Prompt | Current → replacement | Similarity | Result | Note |", "|---|---|---|---|---|");
    for (const d of drift) {
      const score = typeof d.score === "number" ? d.score.toFixed(2) : "";
      lines.push(`| ${esc(d.id)} | \`${esc(d.from)}\` → \`${esc(d.to)}\` | ${score} | ${RESULT_LABEL[d.result] || d.result} | ${esc(d.note)} |`);
    }
    const details = drift.filter((d) => d.before !== undefined);
    if (details.length) {
      lines.push("", "<details><summary>Full answers</summary>", "");
      for (const d of details) {
        lines.push(`#### ${esc(d.id)}`, "", `**${d.from}**`, "", "```", (d.before || "").slice(0, 4000), "```", "", `**${d.to}**`, "", "```", (d.after || "").slice(0, 4000), "```", "");
      }
      lines.push("</details>");
    }
  }

  if (notices.length) lines.push("", ...notices.map((n) => `> ${n}`));
  lines.push("", `<sub>Retirement dates checked against official provider pages on ${registry.checked}. ` +
    `Sources: [OpenAI](${registry.sources.openai}) · [Anthropic](${registry.sources.anthropic}) · [Google](${registry.sources.google}).</sub>`);
  return lines.join("\n");
}
