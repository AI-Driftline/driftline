#!/usr/bin/env node
// GitHub Action entry point.
import { resolve } from "node:path";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { run } from "./run.js";
import { input, setOutput, writeSummary, annotate, upsertIssue } from "./github.js";

const STATUS_TEXT = {
  retired: "is retired",
  "at-risk": "retires soon",
  deprecated: "is deprecated",
};

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const root = resolve(workspace, input("path", "."));
  let isDir = false;
  try { isDir = statSync(root).isDirectory(); } catch {}
  if (!isDir) throw new Error(`path "${input("path", ".")}" is not a folder in this repository`);
  const wd = Number(input("warn-days", "90"));
  const warnDays = Number.isFinite(wd) && wd >= 0 ? wd : 90;
  let failOn = input("fail-on", "retired").toLowerCase();
  if (!["retired", "at-risk", "never"].includes(failOn)) {
    annotate("warning", `Unknown fail-on value "${failOn}". Use retired, at-risk or never. Using "retired".`);
    failOn = "retired";
  }

  const result = await run({
    root,
    repoRoot: workspace,
    warnDays,
    promptsFile: input("prompts-file", ".driftline/prompts.yml"),
    licenseKey: input("license-key"),
    account: process.env.GITHUB_REPOSITORY_OWNER || "",
    log: (m) => console.log(m),
    answers: input("show-answers", "true") !== "false",
  });

  // GitHub shows only a handful of annotations per step; send the most urgent, point to the report for the rest.
  const MAX_ANNOTATIONS = 50;
  const rank = { retired: 0, "at-risk": 1, deprecated: 2 };
  const toAnnotate = result.findings
    .filter((f) => STATUS_TEXT[f.status])
    .sort((a, b) => (a.doc - b.doc) || (rank[a.status] - rank[b.status]));
  if (toAnnotate.length > MAX_ANNOTATIONS) {
    annotate("notice", `${toAnnotate.length - MAX_ANNOTATIONS} more model references are listed in the job summary.`);
  }
  for (const f of toAnnotate.slice(0, MAX_ANNOTATIONS)) {
    const level = f.status === "deprecated" || f.doc ? "notice" : "warning";
    const repl = f.entry?.replacement ? ` Replacement: ${f.entry.replacement}.` : "";
    const text = f.entry.qualifier === "earliest" && f.days <= 0
      ? `${f.id} is past its earliest shutdown date (${f.entry.retires}) and may stop working at any time.`
      : `${f.id} ${STATUS_TEXT[f.status]} (${f.entry.retires}).`;
    annotate(level, text + repl, f.file, f.line);
  }

  // The report contains model answers; stop GitHub from reading any "::command::" lines inside it.
  const token = `driftline-${randomUUID()}`;
  console.log(`::stop-commands::${token}`);
  console.log("\n" + result.markdown);
  console.log(`::${token}::`);
  writeSummary(result.markdown);
  setOutput("findings", result.findings.length);
  setOutput("at-risk", result.atRisk);

  if (input("create-issue", "false") === "true") {
    // Something flagged in code: open or update the issue. Nothing flagged: close it with the all-clear.
    const flagged = result.findings.some((f) => STATUS_TEXT[f.status] && !f.doc);
    const body = flagged ? result.issueMarkdown : `${result.issueMarkdown}\n\n✅ No retired or retiring models are left in the code. Closing this issue.`;
    try {
      const issue = await upsertIssue(body, { token: input("github-token"), close: !flagged });
      if (issue.url) console.log(`${issue.closed ? "Closed" : issue.updated ? "Updated" : "Opened"} issue: ${issue.url}`);
      else console.log(issue.skipped);
    } catch (e) {
      annotate("warning", `Driftline issue: ${e.message}`);
    }
  }

  // Mentions in Markdown and text files are reported but never fail the build.
  const inCode = result.findings.filter((f) => !f.doc);
  const retired = inCode.some((f) => f.status === "retired");
  const atRisk = inCode.some((f) => f.status === "at-risk");
  if ((failOn === "retired" && retired) || (failOn === "at-risk" && (retired || atRisk))) {
    console.log(`::error::Driftline found ${failOn === "retired" ? "retired" : "retired or soon-to-retire"} models (fail-on: ${failOn}).`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log(`::error::Driftline failed: ${e.message}`);
  process.exitCode = 1;
});
