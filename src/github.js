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
const escProp = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");

export function annotate(level, message, file, line) {
  const loc = file ? ` file=${escProp(file)},line=${line}` : "";
  console.log(`::${level}${loc}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
}

const TITLE = "Driftline: AI model retirement report";

async function failure(res, what) {
  let detail = "";
  try { detail = ((await res.json())?.message || "").slice(0, 200); } catch {}
  const hint = res.status === 403 || res.status === 404 ? ' Does the workflow have "issues: write" permission?' : "";
  return new Error(`Could not ${what}: HTTP ${res.status}${detail ? ` (${detail})` : ""}.${hint}`);
}

// Opens one issue labelled "driftline", or updates it if it is already open.
// With close: true, an open report issue is updated with the all-clear and closed; none is opened.
export async function upsertIssue(body, { token, repo = process.env.GITHUB_REPOSITORY, fetchImpl = fetch, close = false } = {}) {
  if (!token || !repo) return { skipped: "No GitHub token or repository." };
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  const list = await fetchImpl(`${api}/repos/${repo}/issues?labels=driftline&state=open&per_page=100`, { headers });
  if (!list.ok) throw await failure(list, "list issues");
  const existing = (await list.json()).find((i) => i.title === TITLE && !i.pull_request);
  if (close && !existing) return { skipped: "Nothing flagged and no open Driftline issue." };
  const url = existing ? `${api}/repos/${repo}/issues/${existing.number}` : `${api}/repos/${repo}/issues`;
  const res = await fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    headers,
    body: JSON.stringify(existing ? { body, ...(close ? { state: "closed" } : {}) } : { title: TITLE, body, labels: ["driftline"] }),
  });
  if (!res.ok) throw await failure(res, `${existing ? "update" : "open"} issue`);
  const issue = await res.json();
  return { number: issue.number, url: issue.html_url, updated: Boolean(existing), closed: close };
}
