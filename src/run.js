import { join } from "node:path";
import { loadRegistry, classify, isTextModel } from "./registry.js";
import { scanDirectory } from "./scan.js";
import { loadPrompts } from "./prompts.js";
import { complete, providerOf, keyFor, missingKeyMessage } from "./providers.js";
import { compare, extractJson } from "./compare.js";
import { checkLicense } from "./license.js";
import { renderReport } from "./report.js";

const MAX_PROMPTS = 20;
const FLAGGED = new Set(["retired", "at-risk", "deprecated"]);

export async function run({
  root = ".",
  warnDays = 90,
  promptsFile = ".driftline/prompts.yml",
  licenseKey = "",
  env = process.env,
  fetchImpl = fetch,
  today = new Date(),
  registry = loadRegistry(),
  log = () => {},
} = {}) {
  const notices = [];
  const raw = scanDirectory(root, { ignore: [".driftline/"], known: registry.byId });
  const findings = raw.map((h) => ({ ...h, ...classify(h.id, registry, { today, warnDays }) }));
  log(`Scanned ${root}: ${findings.length} model reference(s).`);

  let drift = [];
  const prompts = loadPrompts(join(root, promptsFile));
  if (prompts?.length) {
    const lic = await checkLicense(licenseKey, { fetchImpl });
    if (lic.reason) notices.push(lic.reason);
    if (lic.ok) drift = await runDrift({ prompts, findings, registry, env, fetchImpl, today, warnDays, notices, log });
  } else if (findings.some((f) => FLAGGED.has(f.status))) {
    notices.push(`Add ${promptsFile} to test your real prompts on the replacement model before you switch.`);
  }

  const atRisk = findings.filter((f) => f.status === "retired" || f.status === "at-risk").length;
  const markdown = renderReport({ findings, drift, registry, notices });
  return { findings, drift, notices, atRisk, markdown };
}

async function runDrift({ prompts, findings, registry, env, fetchImpl, today, warnDays, notices, log }) {
  if (prompts.length > MAX_PROMPTS) {
    notices.push(`Only the first ${MAX_PROMPTS} prompts were tested.`);
    prompts = prompts.slice(0, MAX_PROMPTS);
  }
  const flaggedModels = [...new Set(findings.filter((f) => FLAGGED.has(f.status) && f.entry?.replacement && isTextModel(f.entry)).map((f) => f.id))];
  const out = [];

  for (const p of prompts) {
    const froms = p.model ? [p.model] : flaggedModels;
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
      log(`Drift test ${p.id}: ${from} → ${to}`);
      try {
        const after = await complete({ model: to, prompt: p.prompt, system: p.system, env, fetchImpl });
        if (status.status === "retired") {
          const jsonOk = p.expect !== "json" || extractJson(after).ok;
          out.push({ id: p.id, from, to, after, before: "(current model already retired)", result: jsonOk ? "changed" : "broken",
            note: jsonOk ? "Current model is retired; review the replacement's answer" : "Replacement did not return valid JSON" });
          continue;
        }
        const before = await complete({ model: from, prompt: p.prompt, system: p.system, env, fetchImpl });
        out.push({ id: p.id, from, to, before, after, ...compare(before, after, p.expect) });
      } catch (e) {
        out.push({ id: p.id, from, to, result: "error", note: e.message.slice(0, 200) });
      }
    }
  }
  return out;
}
