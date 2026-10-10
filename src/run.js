import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadRegistry, classify, isTextModel } from "./registry.js";
import { scanDirectory } from "./scan.js";
import { loadPrompts } from "./prompts.js";
import { complete, providerOf, keyFor, missingKeyMessage } from "./providers.js";
import { compare, extractJson } from "./compare.js";
import { checkLicense } from "./license.js";
import { renderReport } from "./report.js";

const MAX_PROMPTS = 20;
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ");
const FLAGGED = new Set(["retired", "at-risk", "deprecated"]);

export async function run({
  root = ".",
  repoRoot = root,      // the repository root: prompt file and report paths are relative to it
  warnDays = 90,
  promptsFile = ".driftline/prompts.yml",
  licenseKey = "",
  account = "",         // GitHub owner the workflow runs in; the license must be activated for it
  env = process.env,
  fetchImpl = fetch,
  today = new Date(),
  registry = loadRegistry(),
  log = () => {},
  answers = true,       // include model answers in the job summary
} = {}) {
  const notices = [];
  const prefix = relative(repoRoot, root).split(sep).join("/");
  const raw = scanDirectory(root, { ignore: [".driftline/"], known: registry.byId });
  const findings = raw.map((h) => ({
    ...h,
    file: prefix && !prefix.startsWith("..") ? `${prefix}/${h.file.split(sep).join("/")}` : h.file.split(sep).join("/"),
    ...classify(h.id, registry, { today, warnDays }),
  }));
  log(`Scanned ${root}: ${findings.length} model reference(s).`);

  let drift = [];
  let prompts = null;
  try {
    // Repo root first; a monorepo may keep the file next to the scanned folder instead.
    const file = [join(repoRoot, promptsFile), join(root, promptsFile)].find((f) => existsSync(f));
    prompts = file ? loadPrompts(file) : null;
  } catch (e) {
    notices.push(`Could not read ${promptsFile}: ${e.message}. The scan still ran; drift tests were skipped.`);
  }
  if (prompts && !prompts.length) {
    notices.push(`${promptsFile} has no prompts in it, so drift tests were skipped.`);
  } else if (prompts?.length) {
    try {
      const lic = await checkLicense(licenseKey, { fetchImpl, account });
      if (lic.reason) notices.push(lic.reason);
      if (lic.ok) drift = await runDrift({ prompts, findings, registry, env, fetchImpl, today, warnDays, notices, log });
    } catch (e) {
      // Drift tests are extra; the free scan must still produce its report.
      notices.push(`Drift tests stopped: ${e.message}. The scan results above are complete.`);
    }
  } else if (findings.some((f) => FLAGGED.has(f.status))) {
    notices.push(`Add ${promptsFile} to test your real prompts on the replacement model before you switch.`);
  }

  const atRisk = findings.filter((f) => !f.doc && (f.status === "retired" || f.status === "at-risk")).length;
  const markdown = renderReport({ findings, drift, registry, notices, answers });
  // The issue never carries model answers: in a public repository anyone can read it.
  const issueMarkdown = renderReport({ findings, drift, registry, notices, answers: false });
  return { findings, drift, notices, atRisk, markdown, issueMarkdown };
}

async function runDrift({ prompts, findings, registry, env, fetchImpl, today, warnDays, notices, log }) {
  if (prompts.length > MAX_PROMPTS) {
    notices.push(`Only the first ${MAX_PROMPTS} prompts were tested.`);
    prompts = prompts.slice(0, MAX_PROMPTS);
  }
  // Models in code (not docs) that are going away and have a known replacement, soonest first.
  const flaggedModels = [...new Set(findings
    .filter((f) => !f.doc && FLAGGED.has(f.status) && f.entry?.replacement && isTextModel(f.entry))
    .sort((a, b) => a.days - b.days)
    .map((f) => f.id))];
  // A prompt without "model" is tested once, on the model that retires first: two API calls per prompt.
  if (flaggedModels.length > 1 && prompts.some((p) => !p.model)) {
    notices.push(`Prompts without "model" were tested on ${flaggedModels[0]}, the model that retires first. Set "model" on a prompt to test it on another one.`);
  }
  const out = [];

  for (const p of prompts) {
    const froms = p.model ? [p.model] : flaggedModels.slice(0, 1);
    if (!froms.length) {
      out.push({ id: p.id, from: "—", to: "—", result: "skipped", note: "No retiring model found and no \"model\" set for this prompt" });
      continue;
    }
    for (const from of froms) {
      const status = classify(from, registry, { today, warnDays });
      const to = p.compare_to || status.entry?.replacement;
      if (!to) {
        out.push({ id: p.id, from, to: "—", result: "skipped", note: "No known replacement; set compare_to" });
        continue;
      }
      const missing = [from, to].map(providerOf).find((pr) => !keyFor(pr, env));
      if (missing) {
        out.push({ id: p.id, from, to, result: "error", note: missingKeyMessage(missing) });
        continue;
      }
      log(oneLine(`Drift test ${p.id}: ${from} → ${to}`));
      try {
        const after = await complete({ model: to, prompt: p.prompt, system: p.system, env, fetchImpl });
        if (status.status === "retired") {
          if (!after.trim()) {
            out.push({ id: p.id, from, to, after, before: "(current model already retired)", result: "broken", note: "Replacement returned an empty answer" });
            continue;
          }
          const jsonOk = p.expect !== "json" || extractJson(after).ok;
          out.push({ id: p.id, from, to, after, before: "(current model already retired)", result: jsonOk ? "changed" : "broken",
            note: jsonOk ? "Current model is retired; review the replacement's answer" : "Replacement did not return valid JSON" });
          continue;
        }
        let before;
        try {
          before = await complete({ model: from, prompt: p.prompt, system: p.system, env, fetchImpl });
        } catch (e) {
          if (!/^(Empty answer|Answer cut off)/.test(e.message)) throw e;
          // The current model gave nothing usable; the replacement's answer is still worth showing.
          out.push({ id: p.id, from, to, after, before: `(${e.message})`, result: "changed", note: `Current model: ${e.message}. Review the replacement's answer` });
          continue;
        }
        out.push({ id: p.id, from, to, before, after, ...compare(before, after, p.expect) });
      } catch (e) {
        out.push({ id: p.id, from, to, result: "error", note: e.message.slice(0, 200) });
      }
    }
  }
  return out;
}
