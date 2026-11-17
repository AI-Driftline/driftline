import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadRegistry, classify, isTextModel, replacementChange, shownId } from "./registry.js";
import { scanDirectory } from "./scan.js";
import { loadPrompts } from "./prompts.js";
import { complete, providerOf, keyFor, missingKeyMessage } from "./providers.js";
import { compare, extractJson, runChecks, hasChecks } from "./compare.js";
import { checkLicense } from "./license.js";
import { renderReport } from "./report.js";
import { migrationFor } from "./migration.js";

const MAX_PROMPTS = 20;
const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ");
const FLAGGED = new Set(["retired", "at-risk", "deprecated"]);

// A provider refusing the current model itself (not the key, the network or a rate limit).
const UNAVAILABLE = /^HTTP 404:|^HTTP 400:.*\bmodel\b.*(not found|no longer|does not exist|deprecated|decommission|not supported|retired)/i;

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
    ...(/^(vertex|azure|groq|mistral|xai|cohere|deepseek):/.test(h.id) ? { id: shownId(h.id) } : {}), // "gemini-2.5-pro (Vertex AI)", "qwen/qwen3-32b (Groq)"
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
  } else if (findings.some((f) => FLAGGED.has(f.status) && !f.entry?.platform)) { // drift tests call the maker's own API, not Bedrock
    notices.push(`Before you switch, test the prompts your app really sends on the replacement model: list them in ${promptsFile} and Driftline Pro runs each one on both models and shows what changed. https://aidriftline.com/#drift`);
  }

  const atRisk = findings.filter((f) => !f.doc && (f.status === "retired" || f.status === "at-risk")).length;
  const markdown = renderReport({ findings, drift, registry, notices, answers, today });
  // The issue never carries model answers: in a public repository anyone can read it.
  const issueMarkdown = renderReport({ findings, drift, registry, notices, answers: false, today });
  return { findings, drift, notices, atRisk, markdown, issueMarkdown };
}

async function runDrift({ prompts, findings, registry, env, fetchImpl, today, warnDays, notices, log }) {
  if (prompts.length > MAX_PROMPTS) {
    notices.push(`Only the first ${MAX_PROMPTS} prompts were tested.`);
    prompts = prompts.slice(0, MAX_PROMPTS);
  }
  // Models in code (not docs) that are going away and have a known replacement, soonest first.
  const flaggedModels = [...new Set(findings
    .filter((f) => !f.doc && FLAGGED.has(f.status) && f.entry?.replacement && isTextModel(f.entry) && !f.entry.platform) // drift tests call the maker's own API
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
      // The provider's replacement comes with an extra instruction (e.g. "reasoning.mode: pro") that this test
      // doesn't apply: say so on every row, so nobody reads a plain-mode answer as the replacement's best.
      const chg = !p.compare_to && replacementChange(status.entry, today);
      // The provider says the replacement runs in a mode (e.g. reasoning.mode: pro): test it that way, as the customer would run it.
      const proMode = !p.compare_to && /reasoning\.mode: pro/.test(status.entry?.replacement_note || "") && providerOf(to) === "openai" ? "pro" : null;
      const mig = !p.compare_to ? migrationFor(status.entry) : null;
      const caveat = [
        proMode ? "Replacement tested with reasoning.mode: pro, as the provider recommends." : "",
        !p.compare_to && !proMode && status.entry?.replacement_note
          ? `Tested without "${status.entry.replacement_note}", which the provider says the replacement needs; answers after a correct switch may differ.` : "",
        mig && !mig.drop_in && mig.change !== "settings" ? `Beyond the model name: ${mig.note}` : "",
        chg ? `The provider changed this replacement on ${chg.on} (before: ${chg.was}); drift results from earlier runs compared against ${chg.was}.` : "",
      ].filter(Boolean).join(" ");
      // The caveat is kept apart too, so a table can show one that repeats on many rows just once.
      const push = (row) => out.push(caveat ? { ...row, note: [row.note, caveat].filter(Boolean).join(" "), caveat } : row);
      if (!to) {
        push({ id: p.id, from, to: "—", result: "skipped", note: "No known replacement; set compare_to" });
        continue;
      }
      const missing = [from, to].map(providerOf).find((pr) => !keyFor(pr, env));
      if (missing) {
        push({ id: p.id, from, to, result: "error", note: missingKeyMessage(missing) });
        continue;
      }
      log(oneLine(`Drift test ${p.id}: ${from} → ${to}`));
      try {
        const after = await complete({ model: to, prompt: p.prompt, system: p.system, reasoningMode: proMode, env, fetchImpl });
        // Only the replacement's answer can be judged (current model retired, or this key can't use it): JSON and the
        // phrase checks still run on it; same_fields needs the current answer, so it can't.
        const afterOnly = (before, reason) => {
          if (!after.trim()) return push({ id: p.id, from, to, after, before, result: "broken", note: "Replacement returned an empty answer" });
          const jsonOk = p.expect !== "json" || extractJson(after).ok;
          const fails = jsonOk ? runChecks(after, p, { expect: p.expect }) : [];
          // `only`: there was no current answer to compare with. Still "changed" for the counts (a person should read it),
          // but tables label it as its own case instead of a "Changed" without a score.
          // Only phrase checks can run on one answer, so only they count as "checked" here.
          const phraseChecks = hasChecks({ must_include: p.must_include, must_not_include: p.must_not_include });
          push({ id: p.id, from, to, after, before, result: jsonOk && !fails.length ? "changed" : "broken", only: true, checked: phraseChecks,
            note: !jsonOk ? `Replacement did not return valid JSON. ${reason}.`
              : fails.length ? `Failed check: ${fails.map((f) => f.note).join(", ")}. ${reason}.`
              : [`${reason}.`, p.expect === "json" ? "The answer is valid JSON." : "",
                  p.same_fields?.length ? "same_fields needs the current answer, so it was not checked." : ""].filter(Boolean).join(" ") });
        };
        if (status.status === "retired") {
          afterOnly("(current model already retired)", "Current model is retired");
          continue;
        }
        let before;
        try {
          before = await complete({ model: from, prompt: p.prompt, system: p.system, env, fetchImpl });
        } catch (e) {
          if (/^(Empty answer|Answer cut off)/.test(e.message)) {
            // The current model gave nothing usable; the replacement's answer is still worth showing.
            push({ id: p.id, from, to, after, before: `(${e.message})`, result: "changed", note: `Current model: ${e.message}. Review the replacement's answer` });
            continue;
          }
          // The same key just reached the replacement, so a 404 (or a 400 about the model) means this key can't use the
          // current model: providers block new accounts from models that are about to go (Google: "no longer available
          // to new users"). Test the replacement anyway, as for a retired model.
          if (UNAVAILABLE.test(e.message)) {
            afterOnly(`(current model not available: ${e.message.slice(0, 160)})`, "Current model not available to this API key");
            continue;
          }
          throw e;
        }
        push({ id: p.id, from, to, before, after, ...compare(before, after, p.expect, p) });
      } catch (e) {
        push({ id: p.id, from, to, result: "error", note: e.message.slice(0, 200) });
      }
    }
  }
  return out;
}
