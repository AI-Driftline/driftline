// SARIF 2.1.0 output, so findings show in GitHub's code scanning (Security → Code scanning) and in other tools
// that read SARIF. One rule per status; one result per flagged model reference, on its exact file and line.
import { replacementText, platformText, vertexNote, reviewText } from "./registry.js";
import { migrationFor } from "./migration.js";

const HELP = "https://aidriftline.com/models/";
const RULES = {
  retired: { id: "driftline/retired-model", name: "RetiredModel", level: "error",
    short: "AI model is retired", full: "This model ID is past its retirement date: calls fail, or are answered by another model." },
  "at-risk": { id: "driftline/retiring-model", name: "RetiringModel", level: "warning",
    short: "AI model retires soon", full: "This model ID retires within the warning window (90 days by default)." },
  deprecated: { id: "driftline/deprecated-model", name: "DeprecatedModel", level: "note",
    short: "AI model is deprecated", full: "A retirement date is announced for this model ID." },
};

function message(f) {
  const e = f.entry;
  const when = e.routes ? `re-routed from ${e.retires}` : f.status === "retired" ? `retired on ${e.retires}` : `retires on ${e.retires}`;
  const parts = [`${f.id} is ${f.status === "retired" ? "retired" : f.status === "at-risk" ? "retiring soon" : "deprecated"} (${when}).`];
  if (replacementText(e)) parts.push(`Replacement: ${replacementText(e)}.`);
  const mig = migrationFor(e);
  if (mig && !mig.drop_in && mig.note) parts.push(`Not just a rename: ${mig.note}`);
  const extra = e.platform ? platformText(e) : vertexNote(e);
  if (extra) parts.push(extra);
  if (e.under_review) parts.push(reviewText(e));
  return parts.join(" ");
}

export function toSarif(findings, { version = "0.0.0" } = {}) {
  const flagged = findings.filter((f) => RULES[f.status] && f.entry);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "Driftline", version, semanticVersion: version, informationUri: "https://aidriftline.com",
        rules: Object.entries(RULES).map(([, r]) => ({
          id: r.id, name: r.name, shortDescription: { text: r.short }, fullDescription: { text: r.full }, helpUri: HELP,
          help: { text: `${r.full} Move to the replacement shown in the result, and test your prompts on it before you ship. All dates and sources: ${HELP}` },
          defaultConfiguration: { level: r.level }, properties: { tags: ["ai-models", "deprecation", "maintainability"] },
        })),
      } },
      results: flagged.map((f) => ({
        ruleId: RULES[f.status].id,
        ruleIndex: Object.keys(RULES).indexOf(f.status),
        // Mentions in docs never fail a build; in code scanning they show as notes.
        level: f.doc ? "note" : RULES[f.status].level,
        message: { text: message(f) },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file.split("\\").join("/") }, region: { startLine: f.line } } }],
        partialFingerprints: { "driftline/model": `${f.id}|${f.file}` },
        properties: { model: f.id, retires: f.entry.retires, ...(f.entry.replacement ? { replacement: f.entry.replacement } : {}) },
      })),
    }],
  };
}
