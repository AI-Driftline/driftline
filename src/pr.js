// The fix pull request: one branch ("driftline/model-updates") with the safe renames from `fix`, and one pull
// request for it. Later runs rebuild the branch from the default branch and update the same pull request; when
// nothing is left to rename, the pull request is closed. Only the lines `fix` plans are touched.
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyFixes } from "./fix.js";
import { driftTable } from "./report.js";

export const BRANCH = "driftline/model-updates";
export const PR_TITLE = "Driftline: update retiring AI model IDs";
const BOT = ["github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com"];

// Errors name the git command but never its arguments (they can carry the token).
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const cmd = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c");
    throw new Error(`git ${cmd} failed: ${String(e.stderr || "").trim().split("\n").pop().slice(0, 200)}`);
  }
}

// Git options that make fetch/push use this token instead of whatever actions/checkout saved.
export function authArgs(token, server = process.env.GITHUB_SERVER_URL || "https://github.com") {
  if (!token) return [];
  const key = `http.${server.replace(/\/?$/, "/")}.extraheader`;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `${key}=`, "-c", `${key}=AUTHORIZATION: basic ${basic}`];
}

// Builds the fix commit on BRANCH in a separate worktree and pushes it. The checkout itself is never touched, so
// changes made by earlier workflow steps are neither lost nor committed.
// Returns { pushed, unchanged }: unchanged when the remote branch already holds exactly these changes.
export function pushFixBranch({ repoRoot, root, changes, message, remote = "origin", auth = [] }) {
  const tree = mkdtempSync(join(tmpdir(), "driftline-pr-"));
  const sub = relative(repoRoot, root);
  const files = [...new Set(changes.map((c) => join(sub, c.file)))];
  git(repoRoot, ["worktree", "add", "-q", "--detach", tree, "HEAD"]);
  try {
    applyFixes(join(tree, sub), changes);
    git(tree, ["add", "--", ...files]);
    git(tree, ["-c", `user.name=${BOT[0]}`, "-c", `user.email=${BOT[1]}`, "commit", "-q", "--no-verify", "-m", message]);
    let unchanged = false;
    try {
      git(tree, [...auth, "fetch", "-q", "--depth=1", remote, `refs/heads/${BRANCH}`]);
      unchanged = git(tree, ["rev-parse", "FETCH_HEAD^{tree}"]) === git(tree, ["rev-parse", "HEAD^{tree}"]);
    } catch {} // no such branch yet
    if (!unchanged) git(tree, [...auth, "push", "-q", "--force", remote, `HEAD:refs/heads/${BRANCH}`]);
    return { pushed: !unchanged, unchanged };
  } finally {
    git(repoRoot, ["worktree", "remove", "--force", tree]);
  }
}

// The pull request text: what changed, and what a rename can't fix.
// With Pro, `drift` holds the prompt tests from the same run: they go in as scores only (answers stay in the job
// summary, as with the issue, since anyone who can read the pull request would see them).
export function prBody({ changes, skipped }, { cap = 100, drift = [], runUrl = "" } = {}) {
  const row = (c) => `| \`${c.file}:${c.line}\` | \`${c.from}\` → \`${c.to}\` | ${c.status === "retired" ? "retired" : "retires"} ${c.retires} |`;
  const out = [
    `Driftline found ${changes.length} line${changes.length === 1 ? "" : "s"} where a retiring AI model can be swapped for its replacement by a rename.`,
    "",
    "| Where | Change | Why |",
    "|---|---|---|",
    ...changes.slice(0, cap).map(row),
  ];
  if (changes.length > cap) out.push("", `…and ${changes.length - cap} more in the diff.`);
  out.push(...leftForYou(skipped, cap));
  const tested = drift.filter((d) => d.result !== "skipped");
  if (tested.length) {
    const count = (r) => tested.filter((d) => d.result === r).length;
    const [same, changed, broken, failed] = ["same", "changed", "broken", "error"].map(count);
    const verdict = broken
      ? `🔴 **Don't merge yet:** ${broken} prompt${broken === 1 ? "" : "s"} broke on the replacement (empty answer or invalid JSON).`
      : changed
      ? `🟡 **Read before you merge:** ${changed} prompt${changed === 1 ? "" : "s"} got a noticeably different answer.`
      : failed
      ? `⚠️ **Not fully tested:** ${failed} prompt${failed === 1 ? "" : "s"} could not be run (see the note).`
      : "✅ **Safe to merge as far as your prompts show:** every prompt gave the same kind of answer on the replacement.";
    out.push(
      "", "### Your prompts on the replacement", "",
      verdict, "",
      `${tested.length} prompt test${tested.length === 1 ? "" : "s"} from this run: ${same} same, ${changed} changed, ${broken} broken${failed ? `, ${failed} not run` : ""}.`, "",
      ...driftTable(drift), "",
      runUrl ? `Both answers for every prompt are in the [job summary of this run](${runUrl}). They are left out here because anyone who can read this pull request would see them.` : "Both answers for every prompt are in the job summary of the workflow run.",
    );
  } else {
    out.push("", "A rename keeps the call working, but the new model can answer differently. Test your prompts before you merge (Driftline Pro runs them on both models and puts the results in this pull request: https://aidriftline.com/#drift).");
  }
  out.push(
    "",
    "<sub>Opened by the [Driftline](https://github.com/AI-Driftline/driftline) Action. It updates this pull request on later runs and closes it when nothing is left to rename.</sub>",
  );
  return out.join("\n");
}

// Lines a rename can't fix, grouped by model and reason, as a checklist. Mentions in documentation are listed
// apart, without boxes: they are never changed.
function leftForYou(skipped, cap) {
  const code = skipped.filter((s) => !s.doc), docs = skipped.filter((s) => s.doc);
  if (!skipped.length) return [];
  const out = [];
  if (code.length) {
    out.push("", `### Left for you (${code.length})`, "", "A rename isn't enough for these lines, so Driftline didn't touch them. Tick them off as you go; the ticks are kept when this pull request is updated.");
    const groups = new Map();
    for (const s of code) {
      const k = `${s.id}\n${s.reason}`;
      if (!groups.has(k)) groups.set(k, { ...s, places: [] });
      groups.get(k).places.push(`${s.file}:${s.line}`);
    }
    let shown = 0;
    for (const g of groups.values()) {
      if (shown >= cap) break;
      const to = g.to ? ` → \`${g.to}\`${g.alt ? ` or \`${g.alt}\`` : ""}` : "";
      const when = !g.retires ? "" : g.days <= 0 ? ` · shutdown date passed (${g.retires})` : ` · retires ${g.retires}`;
      const why = g.change && g.note ? `**${g.change}.** ${g.note}` : `${g.reason.charAt(0).toUpperCase()}${g.reason.slice(1)}`;
      out.push("", `#### \`${g.id}\`${to}${when}`, "", `${why}${/[.!?]$/.test(why) ? "" : "."}${g.guide ? ` [Provider's guide](${g.guide})` : ""}`, "");
      for (const p of g.places.slice(0, cap - shown)) out.push(`- [ ] \`${p}\``);
      shown += g.places.length;
    }
    if (code.length > cap) out.push("", `…and ${code.length - cap} more (run \`npx @aidriftline/driftline fix --dry-run\`).`);
  }
  if (docs.length) {
    const list = docs.slice(0, 20).map((s) => `\`${s.file}:${s.line}\``).join(", ");
    out.push("", `Also mentioned in documentation, left as written: ${list}${docs.length > 20 ? ` and ${docs.length - 20} more` : ""}.`);
  }
  return out;
}

// Carries the ticked boxes of the current pull request text over to the new one (same heading, same line).
export function keepTicks(next, previous = "") {
  const ticked = new Set();
  let head = "";
  for (const l of String(previous || "").split(/\r?\n/)) {
    if (l.startsWith("#### ")) head = (l.match(/`[^`]+`/) || [l])[0]; // the model ID, not the wording around it
    const m = l.match(/^- \[[xX]\] (`[^`]+`)/);
    if (m) ticked.add(`${head}\n${m[1]}`);
  }
  if (!ticked.size) return next;
  head = "";
  return next.split("\n").map((l) => {
    if (l.startsWith("#### ")) head = (l.match(/`[^`]+`/) || [l])[0]; // the model ID, not the wording around it
    const m = l.match(/^- \[ \] (`[^`]+`)/);
    return m && ticked.has(`${head}\n${m[1]}`) ? l.replace("- [ ]", "- [x]") : l;
  }).join("\n");
}

async function failure(res, what) {
  let detail = "";
  try { detail = ((await res.json())?.message || "").slice(0, 200); } catch {}
  const hint = res.status === 403
    ? ' Give the workflow "contents: write" and "pull-requests: write", and turn on "Allow GitHub Actions to create and approve pull requests" in the repository\'s Actions settings (in the organization\'s settings first if it is greyed out). The changes are on the branch driftline/model-updates meanwhile.'
    : "";
  return new Error(`Could not ${what}: HTTP ${res.status}${detail ? ` (${detail})` : ""}.${hint}`);
}

// Opens the pull request (as a draft where the plan allows it), updates its text, or closes it with close: true.
export async function upsertPullRequest(body, { token, repo, base, fetchImpl = fetch, close = false } = {}) {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  const owner = repo.split("/")[0];
  const list = await fetchImpl(`${api}/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${BRANCH}`)}`, { headers });
  if (!list.ok) throw await failure(list, "list pull requests");
  const existing = (await list.json())[0];
  if (close) {
    if (!existing) return { skipped: "Nothing to rename and no open Driftline pull request." };
    const res = await fetchImpl(`${api}/repos/${repo}/pulls/${existing.number}`, { method: "PATCH", headers, body: JSON.stringify({ state: "closed", body }) });
    if (!res.ok) throw await failure(res, "close the pull request");
    return { url: existing.html_url, closed: true };
  }
  if (existing) {
    const res = await fetchImpl(`${api}/repos/${repo}/pulls/${existing.number}`, { method: "PATCH", headers, body: JSON.stringify({ title: PR_TITLE, body: keepTicks(body, existing.body) }) });
    if (!res.ok) throw await failure(res, "update the pull request");
    return { url: existing.html_url, updated: true };
  }
  const open = (draft) => fetchImpl(`${api}/repos/${repo}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: PR_TITLE, head: BRANCH, base, body, draft }) });
  let res = await open(true);
  if (res.status === 422) res = await open(false); // draft pull requests aren't available on every plan
  if (!res.ok) throw await failure(res, "open the pull request");
  return { url: (await res.json()).html_url, opened: true };
}

export async function defaultBranch({ token, repo, fetchImpl = fetch }) {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const res = await fetchImpl(`${api}/repos/${repo}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!res.ok) throw await failure(res, "read the repository");
  return (await res.json()).default_branch;
}
