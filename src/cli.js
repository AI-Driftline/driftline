#!/usr/bin/env node
// Local use:
//   driftline [directory]              scan and print the report (drift tests run when
//                                      .driftline/prompts.yml, DRIFTLINE_LICENSE_KEY and provider keys exist)
//   driftline activate <license-key>   register this GitHub account; prints the code to save as DRIFTLINE_LICENSE_KEY
//   driftline deactivate <code>        free that account's slot (a key works on up to 3 accounts)
//   driftline [directory] --json       same scan, machine-readable (for scripts and coding agents)
//   driftline fix [directory]          replace retiring IDs where a rename is the whole change (--dry-run to preview)
//   driftline mcp                      MCP server on stdio for coding agents (Claude Code, Cursor, ...)
//   driftline --help | --version
import { loadBestRegistry } from "./registry.js";
import { migrationFor } from "./migration.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { run } from "./run.js";
import { activate, deactivate } from "./license.js";

const JSON_OUT = process.argv.includes("--json");
const DRY_RUN = process.argv.includes("--dry-run");
const SARIF = (() => { const i = process.argv.indexOf("--sarif"); return i > 0 ? process.argv[i + 1] || "driftline.sarif" : ""; })();
const [cmd, arg] = process.argv.slice(2).filter((a, i, all) => a !== "--json" && a !== "--dry-run" && a !== "--sarif" && all[i - 1] !== "--sarif");
const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : ""; };

// "git@github.com:acme/app.git" or "https://github.com/acme/app" -> "acme"
function accountFromGit() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return url.match(/github\.com[:/]([^/]+)\//i)?.[1] || "";
  } catch { return ""; }
}

const HELP = `Driftline: finds AI model IDs in your code and warns before they are retired.

Usage:
  npx @aidriftline/driftline [directory]            scan and print the report
  npx @aidriftline/driftline fix [directory]        replace retiring model IDs where a rename is the whole change
  npx @aidriftline/driftline activate <license-key>  register this GitHub account for Pro
  npx @aidriftline/driftline deactivate <code>       free that account's slot
  npx @aidriftline/driftline mcp                     MCP server for coding agents (stdio)

Options:
  --json             print the scan (or the fix plan) as JSON
  --dry-run          with fix: show what would change, write nothing
  --sarif <file>     also write the findings as SARIF (for GitHub code scanning)
  --account <name>   GitHub account to activate for (default: origin remote owner)
  -h, --help         show this help
  -v, --version      show the version

Exit code: 1 if a retired model is used in code, 0 otherwise.
Retirement dates for every model: https://aidriftline.com/models/
Docs: https://github.com/AI-Driftline/driftline`;

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
} else if (cmd === "-v" || cmd === "--version") {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (cmd?.startsWith("-")) {
  console.error(`Unknown option ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
} else if (cmd === "fix") {
  const { planFixes, applyFixes, fixReport } = await import("./fix.js");
  const { reg } = await loadBestRegistry();
  const root = resolve(arg || ".");
  const plan = planFixes(root, reg);
  if (!DRY_RUN && plan.changes.length) applyFixes(root, plan.changes);
  console.log(JSON_OUT ? JSON.stringify({ dry_run: DRY_RUN, ...plan }, null, 2) : fixReport(plan, { dryRun: DRY_RUN }));
} else if (cmd === "mcp") {
  const { startServer } = await import("./mcp.js");
  startServer();
} else if (cmd === "activate") {
  const account = flag("account") || accountFromGit();
  const r = await activate(arg, account);
  if (!r.ok) { console.error(r.reason); process.exitCode = 1; }
  else {
    console.log(`Activated for GitHub account "${account}"${r.limit ? ` (${r.used} of ${r.limit} used)` : ""}.\n`);
    console.log("Save this as a repository or organization secret named DRIFTLINE_LICENSE_KEY:\n");
    console.log(`  ${r.code}\n`);
  }
} else if (cmd === "deactivate") {
  const r = await deactivate(arg);
  if (!r.ok) { console.error(r.reason); process.exitCode = 1; }
  else console.log("Deactivated. That slot is free for another GitHub account.");
} else {
  const { reg } = await loadBestRegistry();
  const result = await run({
    root: resolve(cmd || "."),
    registry: reg,
    licenseKey: process.env.DRIFTLINE_LICENSE_KEY || "",
    account: process.env.GITHUB_REPOSITORY_OWNER || accountFromGit(),
    log: (m) => console.error(m),
  });
  if (JSON_OUT) {
    const pick = (f) => ({
      id: f.id, file: f.file, line: f.line, status: f.status, docOnly: !!f.doc,
      provider: f.entry?.provider, retires: f.entry?.retires, qualifier: f.entry?.qualifier,
      replacement: f.entry?.replacement, replacement_alt: f.entry?.replacement_alt, migration: migrationFor(f.entry) || undefined, routes: !!f.entry?.routes, aliasOf: f.entry?.aliasOf,
    });
    console.log(JSON.stringify({ findings: result.findings.map(pick), drift: result.drift || [] }, null, 2));
  } else console.log(result.markdown);
  if (SARIF) {
    const { toSarif } = await import("./sarif.js");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(SARIF, JSON.stringify(toSarif(result.findings, { version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version }), null, 2) + "\n");
    console.error(`SARIF written to ${SARIF}`);
  }
  process.exitCode = result.findings.some((f) => f.status === "retired" && !f.doc) ? 1 : 0;
}
