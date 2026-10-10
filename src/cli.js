#!/usr/bin/env node
// Local use: node src/cli.js [directory]
// Runs the same scan as the Action and prints the report. Drift tests run when
// .driftline/prompts.yml exists, DRIFTLINE_LICENSE_KEY is set, and provider keys are in the environment.
import { resolve } from "node:path";
import { run } from "./run.js";

const root = resolve(process.argv[2] || ".");
const result = await run({
  root,
  licenseKey: process.env.DRIFTLINE_LICENSE_KEY || "",
  log: (m) => console.error(m),
});
console.log(result.markdown);
process.exitCode = result.findings.some((f) => f.status === "retired") ? 1 : 0;
