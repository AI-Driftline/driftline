import { appendFileSync } from "node:fs";

export function input(name, fallback = "") {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined || v === "" ? fallback : v.trim();
}

export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

// GitHub workflow commands for annotations on the changed lines.
export function annotate(level, message, file, line) {
  const loc = file ? ` file=${file},line=${line}` : "";
  console.log(`::${level}${loc}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
}

const TITLE = "Driftline: AI model retirement report";

// Opens one issue labelled "driftline", or updates it if it is already open.
export async function upsertIssue(body, { token, repo = process.env.GITHUB_REPOSITORY, fetchImpl = fetch } = {}) {
  if (!token || !repo) return { skipped: "No GitHub token or repository." };
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  const list = await fetchImpl(`${api}/repos/${repo}/issues?labels=driftline&state=open&per_page=10`, { headers });
  if (!list.ok) throw new Error(`Could not list issues: HTTP ${list.status}`);
  const existing = (await list.json()).find((i) => i.title === TITLE && !i.pull_request);
  const url = existing ? `${api}/repos/${repo}/issues/${existing.number}` : `${api}/repos/${repo}/issues`;
  const res = await fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    headers,
    body: JSON.stringify(existing ? { body } : { title: TITLE, body, labels: ["driftline"] }),
  });
  if (!res.ok) throw new Error(`Could not ${existing ? "update" : "open"} issue: HTTP ${res.status}`);
  const issue = await res.json();
  return { number: issue.number, url: issue.html_url, updated: Boolean(existing) };
}
