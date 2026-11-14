#!/usr/bin/env node
// Compares the registry with the three official deprecation pages, by script (no AI reading):
//   1. every recent or upcoming entry: is its date, and its replacement, still next to its ID on the page?
//   2. any model ID on a page that wasn't there last time (a new row to look at)?
//   3. could each page be read at all?
//
//   node tools/check-pages.mjs [registry/models.json] [--state page-ids.json] [--out report.md] [--disputed disputed.json]
//
// --disputed writes the entries whose date or replacement no longer matches the page, with the day each dispute
// started. The website build marks them "under review" in the live list, so the Action, MCP, emails and posts stop
// presenting them as fact until the registry is fixed. Not rewritten when a page couldn't be read.
//
// Prints a report and, inside GitHub Actions, sets the step output problems=<count>. Exit code is 0 unless the
// script itself fails, so the workflow decides what to do (open or update an issue).
// Used by the 6-hourly website workflow and by the daily registry check before it pushes.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const statePath = opt("--state");
const outPath = opt("--out");
const disputedPath = opt("--disputed");
const regPath = resolve(args[0] || new URL("../registry/models.json", import.meta.url).pathname);
const reg = JSON.parse(readFileSync(regPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const back = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

// Model-ID shapes per page, for spotting new rows. Section anchors and prose words are filtered out below.
const SHAPES = {
  openai: /\b(?:gpt|o\d|tts|whisper|dall-e|sora|davinci|babbage|text-embedding|omni-moderation|chatgpt|codex|computer-use)[\w.-]*[a-z0-9]\b/g,
  anthropic: /\bclaude-[a-z0-9][\w.-]*[a-z0-9]\b/g,
  google: /\b(?:gemini|imagen|veo|lyria|text-embedding|embedding)-[\w.-]*[a-z0-9]\b/g,
};
const NOT_ID = /-(models|deprecated-models|preview-models)$|^gemini-\d(\.\d)?$|-guide$|^gpt-oss$/;

const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#x27;/g, "'")
  .replace(/[`*]/g, " ").replace(/\s+/g, " ");
const dateForms = (d) => {
  const x = new Date(d + "T00:00:00Z"), o = { timeZone: "UTC" };
  const M = x.toLocaleString("en-US", { month: "long", ...o }), m = x.toLocaleString("en-US", { month: "short", ...o });
  const D = x.getUTCDate(), Y = x.getUTCFullYear(), DD = String(D).padStart(2, "0");
  return [`${M} ${D}, ${Y}`, `${m} ${D}, ${Y}`, `${m}. ${D}, ${Y}`, `${D} ${M} ${Y}`, `${M} ${DD}, ${Y}`, `${m} ${DD}, ${Y}`, d];
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; driftline-registry-check)" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { url: res.url, text: text(await res.text()) };
    } catch (e) {
      if (attempt >= 2) return { url, error: e.message };
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

const problems = [];
const pages = {};
for (const [provider, url] of Object.entries(reg.sources)) {
  const p = await fetchPage(url);
  const known = reg.models.filter((m) => m.provider === provider);
  const hits = p.text ? known.filter((m) => p.text.includes(m.id)).length : 0;
  // A page that loads but names almost none of our models has changed shape (or is a login/consent page).
  if (p.error || hits < Math.min(10, known.length / 4)) {
    problems.push({ kind: "page", provider, msg: `Could not read the ${provider} page (${p.error || `only ${hits} of ${known.length} known IDs found`}): ${url}` });
    continue;
  }
  pages[provider] = p;
}

// 1. Dates and replacements of entries that matter now: retiring in the future, or retired in the last 90 days.
for (const m of reg.models) {
  const page = pages[m.provider];
  if (!page || m.retires < back) continue;
  const at = [...page.text.matchAll(new RegExp(`(?<![\\w.-])${esc(m.id)}(?![\\w.-])`, "g"))].map((x) => x.index);
  if (!at.length) {
    if (m.retires > today) problems.push({ kind: "missing", what: "listing", provider: m.provider, id: m.id, msg: `\`${m.id}\` (retires ${m.retires}) is no longer on the ${m.provider} page` });
    continue;
  }
  const windows = at.map((i) => page.text.slice(Math.max(0, i - 260), i + 420));
  const dateOk = windows.some((w) => dateForms(m.retires).some((d) => w.includes(d)));
  const replOk = !m.replacement || windows.some((w) => w.includes(m.replacement) && (!m.replacement_alt || w.includes(m.replacement_alt)));
  if (!dateOk || !replOk) {
    const ctx = page.text.slice(Math.max(0, at[0] - 80), at[0] + 220).trim();
    problems.push({ kind: "differs", what: !dateOk && !replOk ? "date and replacement" : !dateOk ? "date" : "replacement", provider: m.provider, id: m.id,
      msg: `\`${m.id}\`: registry says ${!dateOk ? `retires **${m.retires}**` : ""}${!dateOk && !replOk ? ", " : ""}${!replOk ? `replacement **${m.replacement}**` : ""}, ` +
        `not found next to it on the page. Page text: "…${ctx}…"` });
  }
}

// 2. New IDs on a page since the last run (first run: just remember them).
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const ids = new Set(reg.models.map((m) => m.id));
const nextState = { ...state };
for (const [provider, page] of Object.entries(pages)) {
  const seen = [...new Set(page.text.match(SHAPES[provider]) || [])].filter((id) => !NOT_ID.test(id)).sort();
  if (state[provider]) {
    for (const id of seen.filter((x) => !state[provider].includes(x) && !ids.has(x))) {
      const i = page.text.indexOf(id);
      problems.push({ kind: "new", provider, id, msg: `New on the ${provider} page: \`${id}\`. Page text: "…${page.text.slice(Math.max(0, i - 80), i + 200).trim()}…"` });
    }
  }
  nextState[provider] = seen;
}
// 3. Providers kept by the AI check from free-text news (platforms.<name>.maintained === "ai", e.g. DeepSeek):
//    every entry must still be mentioned, and a new sentence about retiring / routing one of their models is a lead.
for (const [name, p] of Object.entries(reg.platforms || {})) {
  if (p.maintained !== "ai" || !p.source) continue;
  const page = await fetchPage(p.source);
  // Not counted as a problem: an unreachable news page (e.g. a network allowlist) must never block fixes to the main pages.
  if (page.error || !page.text.includes(name)) { console.error(`Note: could not read the ${p.name || name} page (${page.error || "no model names on it"}): ${p.source}. Skipped.`); continue; }
  for (const m of p.models || []) if (!page.text.includes(m.id)) problems.push({ kind: "missing", what: "listing", provider: name, id: m.id, msg: `\`${m.id}\` is no longer mentioned on the ${p.name || name} page.` });
  const sentences = [...new Set((page.text.match(/[^.]*\b(?:retired|discontinued|deprecated|routed|no longer (?:available|supported))\b[^.]*\./gi) || [])
    .filter((x) => new RegExp(`\\b${name}-[a-z0-9]`, "i").test(x)).map((x) => x.trim()))].sort();
  const key = `${name}:retirement-sentences`;
  if (state[key]) for (const x of sentences.filter((x) => !state[key].includes(x))) problems.push({ kind: "new", provider: name, id: name, msg: `New on the ${p.name || name} page: "${x.slice(0, 400)}"` });
  nextState[key] = sentences;
}
if (statePath) writeFileSync(statePath, JSON.stringify(nextState, null, 1) + "\n");

if (disputedPath && !problems.some((p) => p.kind === "page")) {
  const before = existsSync(disputedPath) ? JSON.parse(readFileSync(disputedPath, "utf8")) : {};
  const now = {};
  for (const p of problems.filter((x) => x.kind === "differs" || x.kind === "missing"))
    now[p.id] = { since: before[p.id]?.since || today, provider: p.provider, what: p.what, page: reg.sources[p.provider] || reg.platforms?.[p.provider]?.source };
  writeFileSync(disputedPath, JSON.stringify(now, null, 1) + "\n");
}

const report = problems.length
  ? [`Registry (checked ${reg.checked}) vs the provider pages, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: **${problems.length} difference${problems.length > 1 ? "s" : ""}**.`, "",
     ...problems.map((p) => `- ${p.msg}`), "",
     "Check each against the page, update `registry/models.json` in AI-Driftline/driftline (rules: docs/registry-rules.md), and push. This issue closes itself when the next check finds no differences."].join("\n")
  : `Registry (checked ${reg.checked}) matches the provider pages.`;
console.log(report);
if (outPath) writeFileSync(outPath, report + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `problems=${problems.length}\n`);
