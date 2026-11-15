#!/usr/bin/env node
// GitHub Action entry point.
import { replacementText, replacementChange, loadBestRegistry, reviewText, platformText, vertexNote } from "./registry.js";
import { migrationFor } from "./migration.js";
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

  const { reg, source } = await loadBestRegistry({ offline: input("registry", "live").toLowerCase() === "bundled" });
  console.log(`Registry: ${source === "live" ? "live copy from aidriftline.com" : "copy bundled with this version"}, checked ${reg.checked}.`);
  const result = await run({
    root,
    repoRoot: workspace,
    registry: reg,
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
    const chg = replacementChange(f.entry);
    const mig = f.entry.routes ? null : migrationFor(f.entry);
    const more = mig && !mig.drop_in && mig.change !== "settings" ? ` Not just a rename: ${mig.note}` : mig?.change === "choose" ? ` ${mig.note}` : "";
    const repl = f.entry?.replacement && !f.entry.routes ? ` Replacement: ${replacementText(f.entry)}.${chg ? ` (Changed by the provider on ${chg.on}; before it was ${chg.was}.)` : ""}` : !f.entry?.replacement && replacementText(f.entry) ? ` ${replacementText(f.entry)}.` : "";
    const text = f.entry.routes && f.entry.replacement
      ? (f.days <= 0
        ? `Since ${f.entry.retires}, requests to ${f.id} are answered by ${f.entry.replacement}. The call still works, but the model behind it changed.`
        : `From ${f.entry.retires}, requests to ${f.id} will be answered by ${f.entry.replacement}. The call keeps working, but the model behind it changes.`)
      : f.entry.qualifier === "earliest" && f.days <= 0
      ? `${f.id} is past its earliest shutdown date (${f.entry.retires}) and may stop working at any time.`
      : `${f.id} ${STATUS_TEXT[f.status]} (${f.entry.retires}).`;
    const routedMore = f.entry.routes && migrationFor(f.entry)?.change === "params" ? ` Before then, apply the request changes the provider lists: ${migrationFor(f.entry).note}` : "";
    const review = f.entry.under_review ? ` ${reviewText(f.entry)}` : "";
    const platform = f.entry.platform ? ` ${platformText(f.entry)}` : (f.entry.vertex || f.entry.azure) ? ` ${vertexNote(f.entry)}` : "";
    annotate(level, text + repl + more + routedMore + platform + review, f.file, f.line);
  }

  // The report contains model answers; stop GitHub from reading any "::command::" lines inside it.
  const token = `driftline-${randomUUID()}`;
  console.log(`::stop-commands::${token}`);
  console.log("\n" + result.markdown);
  console.log(`::${token}::`);
  writeSummary(result.markdown);
  // SARIF for GitHub code scanning: upload it with github/codeql-action/upload-sarif in the next step.
  const sarifFile = input("sarif-file", "");
  if (sarifFile) {
    const { toSarif } = await import("./sarif.js");
    const { writeFileSync, readFileSync } = await import("node:fs");
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    writeFileSync(resolve(workspace, sarifFile), JSON.stringify(toSarif(result.findings, { version }), null, 2) + "\n");
    setOutput("sarif-file", sarifFile);
    console.log(`SARIF written to ${sarifFile}. Upload it with github/codeql-action/upload-sarif to see the findings in code scanning.`);
  }
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

  if (input("fix-pr", "false") === "true") {
    try { await fixPullRequest({ workspace, root, reg, warnDays, drift: result.drift }); }
    catch (e) { annotate("warning", `Driftline pull request: ${e.message}`); }
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

// One pull request with the safe renames, kept up to date; only from the default branch, never from a pull request.
async function fixPullRequest({ workspace, root, reg, warnDays, drift = [] }) {
  const token = input("github-token"), repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return console.log("Fix pull request skipped: no GitHub token or repository.");
  if ((process.env.GITHUB_EVENT_NAME || "").startsWith("pull_request")) return console.log("Fix pull request skipped: this run is for a pull request.");
  const { planFixes } = await import("./fix.js");
  const pr = await import("./pr.js");
  const base = await pr.defaultBranch({ token, repo });
  if (process.env.GITHUB_REF !== `refs/heads/${base}`) return console.log(`Fix pull request skipped: it is only made from ${base}.`);
  const plan = planFixes(root, reg, { warnDays });
  const state = await pr.prState({ token, repo });
  // Someone pushed their own work to the branch: leave the branch and the pull request exactly as they are.
  if (state.open) {
    const people = [...new Set(await pr.humanCommits({ token, repo, number: state.open.number }))];
    if (people.length) return console.log(`::notice::Driftline left its pull request as it is: ${people.join(", ")} added commits to ${pr.BRANCH} (${state.open.html_url}). Merge or close it, and Driftline takes over again on the next run.`);
  }
  if (!plan.changes.length) {
    const r = await pr.upsertPullRequest(`${pr.CLOSED_BY_DRIFTLINE}: the retiring model IDs are gone from the default branch. Closing this pull request.`, { token, repo, base, close: true });
    return console.log(r.closed ? `Closed pull request: ${r.url}` : r.skipped);
  }
  if (!state.open && pr.closedByUser(state.closed, plan.changes)) {
    return console.log(`Fix pull request not reopened: it was closed on ${state.closed.closed_at.slice(0, 10)} (${state.closed.html_url}) and every rename it would make was already in it. A new one opens when another model needs renaming.`);
  }
  const auth = pr.authArgs(token);
  if (auth.length) console.log(`::add-mask::${auth[3].split("basic ")[1]}`);
  const n = plan.changes.length;
  const b = pr.pushFixBranch({ repoRoot: workspace, root, changes: plan.changes, auth, message: `Update ${n} retiring AI model ID${n === 1 ? "" : "s"} (Driftline)` });
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
  const r = await pr.upsertPullRequest(pr.prBody(plan, { drift, runUrl }), { token, repo, base });
  console.log(`${r.opened ? "Opened" : "Updated"} pull request${b.unchanged ? " (code unchanged since the last run)" : ""}: ${r.url}`);
}

main().catch((e) => {
  console.log(`::error::Driftline failed: ${e.message}`);
  process.exitCode = 1;
});
