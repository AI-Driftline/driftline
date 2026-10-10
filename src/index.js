#!/usr/bin/env node
// GitHub Action entry point.
import { resolve } from "node:path";
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
  const warnDays = Number(input("warn-days", "90")) || 90;
  const failOn = input("fail-on", "retired");

  const result = await run({
    root,
    warnDays,
    promptsFile: input("prompts-file", ".driftline/prompts.yml"),
    licenseKey: input("license-key"),
    log: (m) => console.log(m),
  });

  for (const f of result.findings) {
    if (!STATUS_TEXT[f.status]) continue;
    const level = f.status === "deprecated" ? "notice" : "warning";
    const repl = f.entry?.replacement ? ` Replacement: ${f.entry.replacement}.` : "";
    const text = f.entry.qualifier === "earliest" && f.days <= 0
      ? `${f.id} is past its earliest shutdown date (${f.entry.retires}) and may stop working at any time.`
      : `${f.id} ${STATUS_TEXT[f.status]} (${f.entry.retires}).`;
    annotate(level, text + repl, f.file, f.line);
  }

  console.log("\n" + result.markdown);
  writeSummary(result.markdown);
  setOutput("findings", result.findings.length);
  setOutput("at-risk", result.atRisk);

  if (input("create-issue", "false") === "true" && result.findings.some((f) => STATUS_TEXT[f.status])) {
    try {
      const issue = await upsertIssue(result.markdown, { token: input("github-token") });
      if (issue.url) console.log(`${issue.updated ? "Updated" : "Opened"} issue: ${issue.url}`);
      else console.log(issue.skipped);
    } catch (e) {
      annotate("warning", `Could not open the Driftline issue: ${e.message}. Does the workflow have "issues: write" permission?`);
    }
  }

  const retired = result.findings.some((f) => f.status === "retired");
  const atRisk = result.findings.some((f) => f.status === "at-risk");
  if ((failOn === "retired" && retired) || (failOn === "at-risk" && (retired || atRisk))) {
    console.log(`::error::Driftline found ${failOn === "retired" ? "retired" : "retired or soon-to-retire"} models (fail-on: ${failOn}).`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log(`::error::Driftline failed: ${e.message}`);
  process.exitCode = 1;
});
