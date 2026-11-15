#!/usr/bin/env node
// Freshness of every source, for the public status page (aidriftline.com/status/). Read only: changes nothing.
//
//   node tools/status.mjs [registry/models.json] --out status.json [--pages pages-summary.json]
//
// Runs the platform scripts in --check mode (Bedrock, Vertex, Azure, and Groq/Mistral/xAI/Cohere) and records, per
// source, whether its page could be read and whether it still matches the registry. --pages adds the provider pages
// (OpenAI, Anthropic, Google, DeepSeek) from the summary the page check writes (check-pages.mjs --summary).
// A source with no new result keeps its previous entry from --out, with its old time, so a broken step shows as late.
// Used by the 6-hourly website workflow.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const outPath = opt("--out");
const pagesPath = opt("--pages");
const here = dirname(fileURLToPath(import.meta.url));
const regPath = resolve(args[0] || join(here, "..", "registry", "models.json"));
const reg = JSON.parse(readFileSync(regPath, "utf8"));
if (!outPath) { console.error("usage: status.mjs [registry] --out status.json [--pages summary.json]"); process.exit(2); }

const run = (script) => new Promise((done) => execFile(process.execPath, [join(here, script), "--check", regPath], { timeout: 180000, maxBuffer: 8 << 20 },
  (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const at = () => new Date().toISOString();
const results = {};

// One platform per script: exit 0 = matches; exit 1 with change lines = differs; anything else = page not read.
for (const [key, script] of [["bedrock", "bedrock.mjs"], ["vertex", "vertex.mjs"], ["azure", "azure.mjs"]]) {
  const r = await run(script);
  const lines = r.stdout.split("\n").filter((l) => /^(new|changed|gone from page)/.test(l.trim()));
  results[key] = r.code === 0 ? { result: "ok", differences: 0, at: at() }
    : r.code === 1 && lines.length ? { result: "differs", differences: lines.length, at: at() }
    : { result: "unreadable", at: at() };
}

// direct.mjs checks several providers in one run and prints a block per provider, named as in the registry.
{
  const r = await run("direct.mjs");
  const keys = Object.entries(reg.platforms || {}).filter(([, p]) => p.direct && p.maintained !== "ai");
  for (const [key, p] of keys) {
    const name = p.name;
    if (r.stderr.includes(`${name}: couldn't read`)) { results[key] = { result: "unreadable", at: at() }; continue; }
    if (r.stdout.includes(`${name}: matches the page`)) { results[key] = { result: "ok", differences: 0, at: at() }; continue; }
    const block = r.stdout.split(`${name}:\n`)[1];
    if (block !== undefined) {
      const n = block.split("\n").filter((l) => /^(new|changed|gone from page)/.test(l.trim())).length;
      results[key] = n ? { result: "differs", differences: n, at: at() } : { result: "unreadable", at: at() };
    }
    // not mentioned at all (script crashed before it): no new result, the old one stays
  }
}

if (pagesPath && existsSync(pagesPath)) {
  const s = JSON.parse(readFileSync(pagesPath, "utf8"));
  for (const [key, v] of Object.entries(s.sources || {})) results[key] = { ...v, at: s.at };
}

const before = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const sources = { ...(before.sources || {}), ...results };
writeFileSync(outPath, JSON.stringify({ at: at(), sources }, null, 1) + "\n");
for (const [k, v] of Object.entries(sources)) console.log(`${k}: ${v.result}${v.differences ? ` (${v.differences})` : ""}${v.new ? ` (${v.new} new)` : ""} at ${v.at}${results[k] ? "" : " (kept from last run)"}`);
