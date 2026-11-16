#!/usr/bin/env node
// Saves a readable text copy of every provider page the registry is based on, into pages/<name>.txt.
// Run every 6 hours by .github/workflows/platforms.yml, which commits only when a page's text changed,
// so git history shows what each provider changed on its page and when.
//
//   node tools/save-pages.mjs [registry/models.json] [--out pages]
//
// The list of pages comes from the registry (sources + platforms.<name>.source): a new provider is saved
// without editing this file. A page that can't be read keeps its last copy (never overwritten with an error).
// pages/ is outside registry/, so a change here never starts a release, and it isn't in the npm package.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outDir = resolve(oi >= 0 ? args.splice(oi, 2)[1] : new URL("../pages", import.meta.url).pathname);
const reg = JSON.parse(readFileSync(resolve(args[0] || new URL("../registry/models.json", import.meta.url).pathname), "utf8"));

const pages = [
  ...Object.entries(reg.sources || {}),
  ...Object.entries(reg.platforms || {}).filter(([, p]) => p.source).map(([name, p]) => [name, p.source]),
];

const ENTITY = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "–", mdash: "—", hellip: "…" };
// HTML → plain text that keeps one table row, list item or paragraph per line, so a git diff shows
// exactly which row changed. Menus, scripts and page furniture are dropped where the page marks them.
export function pageText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " "); // not noscript: Google's page text lives there
  const main = h.match(/<main\b[\s\S]*<\/main>/i) || h.match(/<article\b[\s\S]*<\/article>/i);
  if (main) h = main[0];
  h = h.replace(/<(nav|header|footer|aside|button|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|tr|li|ul|ol|table|thead|tbody|h[1-6]|pre|blockquote|dt|dd|details|summary)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e.toLowerCase()] ?? m);
  return h.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").replace(/\s*\|\s*$/, "").trim()).filter(Boolean).join("\n") + "\n";
}

async function fetchHtml(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      // English only: without it Google Cloud sometimes answers in another language, which would look like a change.
      const u = new URL(url);
      if (/(^|\.)google\.(com|dev)$/.test(u.hostname) && !u.searchParams.has("hl")) u.searchParams.set("hl", "en");
      const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; driftline-registry-check)", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

mkdirSync(outDir, { recursive: true });
let changed = 0, failed = 0;
for (const [name, url] of pages) {
  const file = join(outDir, `${name}.txt`);
  try {
    const text = pageText(await fetchHtml(url));
    if (text.length < 500) throw new Error(`only ${text.length} characters of text (login or consent page?)`);
    const body = `Source: ${url}\n\n${text}`;
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (before !== body) { writeFileSync(file, body); changed++; console.log(`${name}: ${before ? "changed" : "new"} (${text.split("\n").length} lines)`); }
    else console.log(`${name}: unchanged`);
  } catch (e) {
    failed++;
    console.log(`${name}: could not read ${url} (${e.message}); kept the last copy`);
  }
}
console.log(`${pages.length} pages: ${changed} changed, ${failed} could not be read`);
