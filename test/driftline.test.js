import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRegistry, classify, normalizeId } from "../src/registry.js";
import { scanDirectory, scanText } from "../src/scan.js";
import { parseYamlSubset, loadPrompts } from "../src/prompts.js";
import { compare, extractJson, textSimilarity } from "../src/compare.js";
import { checkLicense } from "../src/license.js";
import { run } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "fixtures", "sample-repo");
const TODAY = new Date("2026-10-10T00:00:00Z");
const registry = loadRegistry();

// ---------- registry ----------
test("registry has unique IDs and valid dates", () => {
  const ids = registry.models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of registry.models) assert.match(m.retires, /^\d{4}-\d{2}-\d{2}$/, m.id);
});

test("classify by date", () => {
  assert.equal(classify("gpt-4o-2024-05-13", registry, { today: TODAY }).status, "at-risk"); // 23 Oct 2026
  assert.equal(classify("claude-3-haiku-20240307", registry, { today: TODAY }).status, "retired");
  assert.equal(classify("gpt-5.1", registry, { today: TODAY }).status, "deprecated"); // Apr 2027
  assert.equal(classify("claude-sonnet-5-5", registry, { today: TODAY }).status, "active");
  assert.equal(classify("gpt-5.6-sol", registry, { today: TODAY }).status, "unknown");
  assert.equal(classify("gpt-4o-2024-05-13", registry, { today: TODAY }).days, 13);
  // Google publishes only the earliest shutdown date: past it is "at risk", not "retired"
  assert.equal(classify("gemini-2.0-flash", registry, { today: TODAY }).status, "at-risk");
});

test("registry covers non-text models and flags them as scan-only", () => {
  assert.equal(registry.byId.get("dall-e-3").kind, "image");
  assert.equal(classify("dall-e-3", registry, { today: TODAY }).status, "retired");
  assert.equal(classify("whisper-1", registry, { today: TODAY }).status, "deprecated"); // 26 Feb 2027
  assert.equal(classify("claude-3-5-sonnet-20241022", registry, { today: TODAY }).status, "retired");
  assert.equal(classify("gpt-4-1106-preview", registry, { today: TODAY }).status, "at-risk");
});

test("normalizeId strips provider prefixes", () => {
  assert.equal(normalizeId("models/text-embedding-004"), "text-embedding-004");
  assert.equal(normalizeId("openai/GPT-4"), "gpt-4");
});

// ---------- scanner ----------
test("scanText finds quoted and assigned IDs, ignores prose", () => {
  const hits = scanText([
    'const a = "gpt-4o-2024-05-13"',
    "MODEL=claude-3-haiku-20240307",
    "model: gemini-2.0-flash  # comment",
    "We use o1 thinking in this doc",       // prose, unquoted: ignored
    'const v = "o1-preview"',
  ].join("\n"), "x.js");
  assert.deepEqual(hits.map((h) => h.id), ["gpt-4o-2024-05-13", "claude-3-haiku-20240307", "gemini-2.0-flash", "o1-preview"]);
  assert.equal(hits[1].line, 2);
  // registry-only IDs are found when the registry is passed in
  const media = scanText('model="dall-e-3"\nname = "whisper-1"\nlabel = "ada"', "m.py", registry.byId).map((h) => h.id);
  assert.deepEqual(media, ["dall-e-3", "whisper-1"]);
  assert.equal(scanText('model="dall-e-3"', "m.py").length, 0);
});

test("scanDirectory skips node_modules and finds sample models", () => {
  const ids = scanDirectory(SAMPLE, { ignore: [".driftline/"] }).map((h) => h.id).sort();
  assert.ok(!ids.includes("gpt-4"), "node_modules must be skipped");
  for (const id of ["gpt-4o-2024-05-13", "claude-sonnet-4-5-20250929", "claude-3-haiku-20240307", "gemini-2.0-flash", "text-embedding-004", "gpt-5.6-sol"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
});

// ---------- prompt file ----------
test("YAML subset parser reads block and quoted values", () => {
  const prompts = loadPrompts(join(SAMPLE, ".driftline", "prompts.yml"));
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].id, "invoice-json");
  assert.equal(prompts[0].expect, "json");
  assert.equal(prompts[0].prompt, "Extract vendor, total and currency from this invoice as JSON:\n\nACME GmbH, Total: 1.250,00 EUR");
  assert.equal(prompts[1].prompt, "Summarise: the printer is jammed again");
  assert.equal(prompts[1].expect, "text");
});

test("YAML parser rejects lines outside a prompt", () => {
  assert.throws(() => parseYamlSubset("foo: bar"), /Cannot read/);
});

// ---------- comparison ----------
test("identical text scores 1, unrelated text scores low", () => {
  assert.equal(textSimilarity("The printer is jammed.", "The printer is jammed."), 1);
  assert.ok(textSimilarity("The printer is jammed", "Quarterly revenue grew strongly") < 0.2);
});

test("JSON comparison: fenced JSON parses, broken JSON is broken", () => {
  assert.equal(extractJson('Here you go:\n```json\n{"a":1}\n```').ok, true);
  const same = compare('{"vendor":"ACME GmbH","total":1250}', '```json\n{"vendor":"ACME GmbH","total":1250}\n```', "json");
  assert.equal(same.result, "same");
  const changed = compare('{"vendor":"ACME GmbH","total":1250,"currency":"EUR"}', '{"vendor":"ACME","total":1250,"currency":"EUR"}', "json");
  assert.equal(changed.result, "changed");
  const broken = compare('{"vendor":"ACME"}', "Sure! The vendor is ACME.", "json");
  assert.equal(broken.result, "broken");
});

// ---------- license ----------
const fakeLicense = (body) => async () => ({ json: async () => body });

test("license: valid, invalid, missing", async () => {
  assert.equal((await checkLicense("k", { fetchImpl: fakeLicense({ valid: true, license_key: { status: "active" } }) })).ok, true);
  assert.equal((await checkLicense("k", { fetchImpl: fakeLicense({ valid: false, error: "license_key not found." }) })).ok, false);
  assert.equal((await checkLicense("", {})).ok, false);
  assert.equal((await checkLicense("k", { fetchImpl: fakeLicense({ valid: true, license_key: { status: "expired" } }) })).ok, false);
});

// ---------- end to end with mocked providers ----------
function fakeProviders(calls) {
  return async (url, opts) => {
    calls.push(url);
    if (url.includes("lemonsqueezy")) return { ok: true, json: async () => ({ valid: true, license_key: { status: "active" } }) };
    const body = JSON.parse(opts.body);
    const reply = (text, shape) => ({ ok: true, status: 200, text: async () => JSON.stringify(shape(text)) });
    if (url.includes("openai")) {
      const text = body.model === "gpt-4o-2024-05-13"
        ? '{"vendor":"ACME GmbH","total":1250,"currency":"EUR"}'
        : "Sure! Here is the data: vendor ACME GmbH, total 1250 EUR."; // replacement breaks JSON
      return reply(text, (t) => ({ output: [{ content: [{ type: "output_text", text: t }] }] }));
    }
    if (url.includes("anthropic")) {
      return reply("The printer is jammed again and needs service.", (t) => ({ content: [{ type: "text", text: t }] }));
    }
    throw new Error("unexpected url " + url);
  };
}

test("run: scan + drift report end to end", async () => {
  const calls = [];
  const result = await run({
    root: SAMPLE, today: TODAY, licenseKey: "test-key",
    env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" },
    fetchImpl: fakeProviders(calls),
  });
  const byId = Object.fromEntries(result.findings.map((f) => [f.id, f.status]));
  assert.equal(byId["gpt-4o-2024-05-13"], "at-risk");
  assert.equal(byId["claude-3-haiku-20240307"], "retired");
  assert.equal(byId["claude-sonnet-4-5-20250929"], "at-risk"); // 30 Nov 2026 is 51 days out
  assert.ok(result.atRisk >= 3);

  assert.equal(byId["dall-e-3"], "retired");
  assert.ok(!result.drift.some((d) => d.from === "dall-e-3" || d.from === "whisper-1"), "non-text models are never drift-tested");
  assert.match(result.markdown, /`dall-e-3` · image/);

  const inv = result.drift.find((d) => d.id === "invoice-json");
  assert.equal(inv.to, "gpt-5.6-sol");
  assert.equal(inv.result, "broken");
  const sum = result.drift.find((d) => d.id === "ticket-summary");
  assert.equal(sum.to, "claude-sonnet-5-5");
  assert.equal(sum.result, "same");

  assert.match(result.markdown, /Driftline report/);
  assert.match(result.markdown, /Replacement did not return valid JSON/);
  assert.ok(calls.some((u) => u.includes("api.openai.com/v1/responses")));
});

test("run without license: scan only, with a notice", async () => {
  const result = await run({ root: SAMPLE, today: TODAY, env: {}, fetchImpl: async () => { throw new Error("no network"); } });
  assert.equal(result.drift.length, 0);
  assert.match(result.markdown, /drift tests need Driftline Pro/);
});

test("run without provider key reports a clear error per prompt", async () => {
  const result = await run({
    root: SAMPLE, today: TODAY, licenseKey: "k", env: { OPENAI_API_KEY: "x" },
    fetchImpl: fakeProviders([]),
  });
  const sum = result.drift.find((d) => d.id === "ticket-summary");
  assert.equal(sum.result, "error");
  assert.match(sum.note, /ANTHROPIC_API_KEY/);
});
