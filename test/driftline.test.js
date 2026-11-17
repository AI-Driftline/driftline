import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRegistry, classify, normalizeId } from "../src/registry.js";
import { scanDirectory, scanText } from "../src/scan.js";
import { parseYamlSubset, loadPrompts } from "../src/prompts.js";
import { compare, extractJson, textSimilarity } from "../src/compare.js";
import { checkLicense, LICENSE } from "../src/license.js";

// Most tests use fake keys without store/product data; the real check is tested on its own below.
const REAL_LICENSE = { ...LICENSE };
Object.assign(LICENSE, { benefitId: null });
// A valid Polar reply for the code "k:i" activated for github:acme.
const POLAR_OK = { status: "granted", benefit_id: null, activation: { id: "i", label: "github:acme" } };
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
const fakeLicense = (body, status = 200) => async () => ({ status, json: async () => body });

test("license: valid, invalid, missing", async () => {
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense(POLAR_OK), account: "acme" })).ok, true);
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense({ error: "ResourceNotFound", detail: "License key not found" }, 404), account: "acme" })).ok, false);
  assert.equal((await checkLicense("", {})).ok, false);
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense({ ...POLAR_OK, status: "revoked" }), account: "acme" })).ok, false);
});

// ---------- end to end with mocked providers ----------
function fakeProviders(calls) {
  return async (url, opts) => {
    calls.push(url);
    if (url.includes("api.polar.sh")) return { ok: true, status: 200, json: async () => POLAR_OK };
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
    root: SAMPLE, today: TODAY, licenseKey: "test-key:i", account: "acme",
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
    root: SAMPLE, today: TODAY, licenseKey: "k:i", account: "acme", env: { OPENAI_API_KEY: "x" },
    fetchImpl: fakeProviders([]),
  });
  const sum = result.drift.find((d) => d.id === "ticket-summary");
  assert.equal(sum.result, "error");
  assert.match(sum.note, /ANTHROPIC_API_KEY/);
});

// ---------- edge cases (found by break-testing, 2026-10-11) ----------
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { renderReport } from "../src/report.js";
import { providerOf } from "../src/providers.js";

const tempRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "driftline-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const licensed = (answer) => async (url) => url.includes("api.polar.sh")
  ? { status: 200, json: async () => POLAR_OK }
  : { ok: true, status: 200, text: async () => JSON.stringify(url.includes("anthropic") ? { content: [{ type: "text", text: answer }] } : { output_text: answer }) };

test("cloud-platform spellings: Vertex maps to provider IDs, Bedrock keeps its own IDs", () => {
  assert.equal(normalizeId("anthropic.claude-3-5-sonnet-20240620-v1:0"), "anthropic.claude-3-5-sonnet-20240620-v1:0");
  assert.equal(normalizeId("us.anthropic.claude-3-5-sonnet-20240620-v2:0"), "anthropic.claude-3-5-sonnet-20240620-v2:0");
  assert.equal(normalizeId("claude-3-5-sonnet@20240620"), "claude-3-5-sonnet-20240620");
  assert.deepEqual(scanText('model="claude-3-5-sonnet@20240620"', "a.py").map((h) => h.id), ["claude-3-5-sonnet-20240620"]);
});

test("Dockerfiles are scanned; Markdown mentions are marked as docs", () => {
  const dir = tempRepo({ Dockerfile: "ENV MODEL=gpt-4\n", "CHANGELOG.md": "Moved off `gpt-4`.\n" });
  const hits = scanDirectory(dir);
  assert.equal(hits.find((h) => h.file === "Dockerfile")?.doc, false);
  assert.equal(hits.find((h) => h.file === "CHANGELOG.md")?.doc, true);
});

test("YAML parser: document marker, comments, quoted #, folded blocks", () => {
  const p = parseYamlSubset([
    "---", "prompts:  # mine",
    "  - id: a", '    prompt: "Close issue #42 today"  # note',
    "  - id: b", "    prompt: >-", "      folded", "      text", "", "      second", "    expect: json",
  ].join("\n")).prompts;
  assert.equal(p[0].prompt, "Close issue #42 today");
  assert.equal(p[1].prompt, "folded text\nsecond");
  assert.equal(p[1].expect, "json");
});

test("checks: a flipped meaning in a long answer is caught (it scored 0.98 'same' before)", () => {
  const a = "Thanks for reaching out. I checked your order 4821 placed on March 3. Based on our policy for items returned within 30 days in original packaging, the customer is eligible for a refund. The amount will go back to the original card within 5 business days.";
  const b = a.replace("is eligible", "is not eligible");
  // The "not" guard: no checks written, still not "same".
  const guarded = compare(a, b);
  assert.equal(guarded.result, "changed");
  assert.match(guarded.note, /says "not"/);
  assert.equal(guarded.checked, false);
  // With a must_not_include check it's broken, and the note names the check.
  const checked = compare(a, b, "text", { must_not_include: ["not eligible"] });
  assert.equal(checked.result, "broken");
  assert.match(checked.note, /Failed check: says "not eligible"/);
  assert.equal(checked.checked, true);
  // Identical answers with the same "not" count stay same.
  assert.equal(compare("It is not ready.", "It is not ready.").result, "same");
  assert.equal(compare("It isn't ready yet, sorry about that.", "It isn\u2019t ready yet, sorry about that!").result, "same");
});

test("run: checks flow through a real run, including a model that is already retired", async () => {
  const dir = tempRepo({
    "a.py": 'old = "claude-3-haiku-20240307"\nnew = "claude-sonnet-4-5-20250929"\n',
    ".driftline/prompts.yml": [
      "prompts:",
      "  - id: retired-miss", "    model: claude-3-haiku-20240307", "    prompt: hi", "    must_include: [refund]",
      "  - id: retired-ok", "    model: claude-3-haiku-20240307", "    prompt: hi", "    must_include: [printer]",
      "  - id: live", "    model: claude-sonnet-4-5-20250929", "    prompt: hi", "    must_not_include: [refund]",
    ].join("\n"),
  });
  const result = await run({ root: dir, today: TODAY, licenseKey: "test-key:i", account: "acme", env: { ANTHROPIC_API_KEY: "y" }, fetchImpl: fakeProviders([]) });
  const by = Object.fromEntries(result.drift.map((d) => [d.id, d]));
  assert.equal(by["retired-miss"].result, "broken");
  assert.match(by["retired-miss"].note, /Failed check: missing "refund"/);
  assert.equal(by["retired-ok"].result, "changed");
  assert.equal(by.live.result, "same");
  assert.equal(by.live.checked, true);
});

test("run: a current model this key can't use still gets its replacement tested", async () => {
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": [
    "prompts:", "  - id: plain", "    prompt: hi", "  - id: checked", "    prompt: hi", "    must_include: [refund]",
  ].join("\n") });
  const refuse = (status, message) => async (url, opts) => {
    if (url.includes("api.polar.sh")) return reply(200, POLAR_OK);
    return JSON.parse(opts.body).model === "gpt-4" ? reply(status, { error: { message } }) : reply(200, { output_text: "Hello there" });
  };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", env: { OPENAI_API_KEY: "x" },
    fetchImpl: refuse(404, "This model gpt-4 is no longer available to new users.") });
  const by = Object.fromEntries(r.drift.map((d) => [d.id, d]));
  assert.equal(by.plain.result, "changed");
  assert.match(by.plain.note, /not available to this API key/);
  assert.equal(by.plain.only, true);
  assert.equal(by.plain.checked, false);
  assert.match(by.plain.before, /^\(current model not available: HTTP 404/);
  assert.equal(by.plain.after, "Hello there");
  assert.equal(by.checked.result, "broken");
  assert.match(by.checked.note, /Failed check: missing "refund"\. Current model not available/);
  // A 400 that names the model counts too; a bad key or a rate limit is still an error, never skipped quietly.
  const r400 = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", env: { OPENAI_API_KEY: "x" },
    fetchImpl: refuse(400, "The model `gpt-4` has been deprecated.") });
  assert.equal(r400.drift[0].result, "changed");
  const r401 = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", env: { OPENAI_API_KEY: "x" },
    fetchImpl: refuse(401, "Incorrect API key provided.") });
  assert.equal(r401.drift[0].result, "error");
});

test("checks: must_include is case- and space-insensitive; a check both models fail is changed, not broken", () => {
  assert.equal(compare("Refund in 5  business days.", "REFUND in 5 business\ndays.", "text", { must_include: ["refund", "5 business days"] }).result, "same");
  const miss = compare("Refund in 5 business days.", "Refund soon.", "text", { must_include: ["5 business days"] });
  assert.equal(miss.result, "broken");
  assert.match(miss.note, /missing "5 business days"/);
  const both = compare("We can help.", "We can help!", "text", { must_include: ["refund"] });
  assert.equal(both.result, "changed");
  assert.match(both.note, /Current model fails this check too: missing "refund"/);
  // Checks never make a result better.
  assert.equal(compare("", "", "text", { must_include: ["x"] }).result, "error");
  assert.equal(compare("abc", "", "text", { must_include: ["x"] }).result, "broken");
});

test("checks: same_fields compares named JSON fields, including nested ones", () => {
  const before = '{"status":"approved","total":1250,"customer":{"id":7},"note":"thanks"}';
  const ok = compare(before, '```json\n{"status":"Approved","total":1250,"customer":{"id":7},"note":"cheers"}\n```', "json", { same_fields: ["status", "total", "customer.id"] });
  assert.equal(ok.result, "changed"); // note differs, so not identical; the named fields all match
  assert.ok(!/Failed check/.test(ok.note));
  const flipped = compare(before, '{"status":"rejected","total":1250,"customer":{"id":7},"note":"thanks"}', "json", { same_fields: ["status"] });
  assert.equal(flipped.result, "broken");
  assert.match(flipped.note, /status: approved → rejected/);
  const gone = compare(before, '{"status":"approved","total":1250,"note":"thanks"}', "json", { same_fields: ["customer.id"] });
  assert.equal(gone.result, "broken");
  assert.match(gone.note, /customer\.id missing/);
  const notInCurrent = compare('{"a":1}', '{"a":1}', "json", { same_fields: ["b"] });
  assert.equal(notInCurrent.result, "changed");
  assert.match(notInCurrent.note, /b missing in the current answer/);
});

test("prompt file: check lists in YAML (one-line and block) and JSON, with clear errors", () => {
  const dir = tempRepo({
    "p.yml": [
      "prompts:",
      "  - id: a",
      "    prompt: hi",
      '    must_include: [refund, "5 business days", \'it\'\'s fine\', "a, b"]',
      "    must_not_include:",
      "    - not eligible",
      "      # a comment",
      '    - "cannot"',
      "  - id: b",
      "    expect: json",
      "    same_fields: status",
      "    prompt: x",
    ].join("\n"),
    "p.json": JSON.stringify({ prompts: [{ prompt: "x", expect: "json", same_fields: ["a.b", "c"] }] }),
    "bad1.yml": "prompts:\n  - prompt: x\n    same_fields: [a]\n",
    "bad2.yml": "prompts:\n  - prompt: x\n    must_include: []\n",
  });
  const [a, b] = loadPrompts(join(dir, "p.yml"));
  assert.deepEqual(a.must_include, ["refund", "5 business days", "it's fine", "a, b"]);
  assert.deepEqual(a.must_not_include, ["not eligible", "cannot"]);
  assert.deepEqual(b.same_fields, ["status"]);
  assert.deepEqual(loadPrompts(join(dir, "p.json"))[0].same_fields, ["a.b", "c"]);
  assert.throws(() => loadPrompts(join(dir, "bad1.yml")), /needs "expect: json"/);
  assert.throws(() => loadPrompts(join(dir, "bad2.yml")), /empty "must_include" list/);
});

test("empty answers, CJK text and JSON after braces are scored sensibly", () => {
  assert.equal(compare("", "").result, "error");
  assert.equal(compare("ok", "").result, "broken");
  assert.ok(textSimilarity("プリンターが紙詰まりしています。今日修理が必要です。", "プリンターが紙詰まりしています。本日修理が必要です。") > 0.9);
  assert.equal(compare('{"a":1}', 'Note {see below}: {"a":1}', "json").result, "same");
});

test("provider routing for embedding models", () => {
  assert.equal(providerOf("text-embedding-3-small"), "openai");
  assert.equal(providerOf("text-embedding-004"), "google");
});

// Real license codes are "DRIFTLINE-<uuid>:<activation uuid>".
const REAL_CODE = "DRIFTLINE-38B1460A-5104-4067-A91D-77B872934D51:f90ec370-fd83-46a5-8bbd-44a241e78665";

test("license: a license server outage does not lock out paying users", async () => {
  const r = await checkLicense(REAL_CODE, { fetchImpl: async () => ({ status: 503, json: async () => { throw new Error("html"); } }), account: "acme" });
  assert.equal(r.ok, true);
  const offline = await checkLicense(REAL_CODE.toUpperCase(), { fetchImpl: async () => { throw new TypeError("fetch failed"); }, account: "acme" });
  assert.equal(offline.ok, true);
});

test("license: without a known GitHub account, a valid code does not unlock Pro", async () => {
  const fetchImpl = async () => reply(200, POLAR_OK);
  for (const account of [undefined, "", "  ", "globex"]) {
    assert.equal((await checkLicense(REAL_CODE, { fetchImpl, account })).ok, false, `account ${JSON.stringify(account)}`);
  }
  assert.equal((await checkLicense(REAL_CODE, { fetchImpl, account: " ACME " })).ok, true);
  const offline = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await checkLicense(REAL_CODE, { fetchImpl: offline })).ok, false, "no outage pass without an account either");
});

test("license: blocking the license server with a made-up code unlocks nothing", async () => {
  const blocked = async () => { throw new TypeError("fetch failed"); };
  const down = async () => ({ status: 503, json: async () => ({}) });
  const busy = async () => ({ status: 429, json: async () => ({}) });
  const [key, inst] = REAL_CODE.split(":");
  const fakes = ["a:b", "k:i", ":", "x:" + inst, key + ":x", key + ":" + inst + "x", key + "::" + inst,
    key.replace(/-/g, "") + ":" + inst, key + ":" + inst.slice(0, -1) + "g", " " + key + " : " + inst,
    key + ":" + inst + "\n" + key, "{{secrets.X}}:" + inst, key];
  for (const code of fakes) {
    for (const fetchImpl of [blocked, down, busy]) {
      const r = await checkLicense(code, { fetchImpl, account: "acme" });
      assert.equal(r.ok, false, `${JSON.stringify(code)} must not unlock Pro`);
    }
  }
});

test("run: a broken prompt file is reported, the scan still runs", async () => {
  const dir = tempRepo({ "app.py": 'model = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    nested:\n      x: 1\n" });
  const r = await run({ root: dir, today: TODAY, registry });
  assert.equal(r.findings.length, 1);
  assert.ok(r.notices.some((n) => n.startsWith("Could not read")));
});

test("run: paths are repo-relative and prompts are found when path points to a subfolder", async () => {
  const dir = tempRepo({ "src/app.ts": 'const m = "gpt-4";\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  const r = await run({ root: join(dir, "src"), repoRoot: dir, today: TODAY, registry });
  assert.equal(r.findings[0].file, "src/app.ts");
  assert.ok(r.notices.some((n) => n.startsWith("No license key")), "prompt file was found, so the license was checked");
});

test("run: prompts without a model cost two calls each, on the soonest-retiring model", async () => {
  const dir = tempRepo({
    "a.py": ['"gpt-4"', '"gpt-5-2025-08-07"', '"claude-sonnet-4-5-20250929"'].map((s) => `m = ${s}`).join("\n"),
    ".driftline/prompts.yml": "prompts:\n" + Array.from({ length: 5 }, (_, i) => `  - id: p${i}\n    prompt: hi ${i}\n`).join(""),
  });
  let calls = 0;
  const fetchImpl = async (url, opts) => { if (!url.includes("api.polar.sh")) calls++; return licensed("hi")(url, opts); };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl, env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" } });
  assert.equal(calls, 10);
  assert.ok(r.drift.every((d) => d.from === "gpt-4"));
});

test("report: model fences can't break it, and it fits a GitHub issue", () => {
  const md = renderReport({ findings: [], registry, drift: [{ id: "p", from: "a", to: "b", score: 1, result: "same", note: "", before: "```json\n{}\n```", after: "x" }] });
  assert.ok(md.includes("````\n```json"));
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, from: "a", to: "b", score: 1, result: "same", note: "", before: "x".repeat(5000), after: "y".repeat(5000) }));
  assert.ok(renderReport({ findings: [], registry, drift: many }).length <= 60000);
});

test("replacements never point at a model that is itself being retired", () => {
  for (const m of registry.models) {
    if (!m.replacement) continue;
    const next = registry.byId.get(m.replacement);
    assert.ok(!next || next.qualifier === "not-before" || !next.replacement, `${m.id} -> ${m.replacement} is retiring too`);
  }
  assert.equal(registry.byId.get("o1-mini").replacement, "gpt-5.6-terra");
  assert.equal(registry.byId.get("o1-mini").via, "o4-mini");
});

// ---------- independent audit findings (2026-10-11) ----------
import { complete, retry } from "../src/providers.js";
import { upsertIssue } from "../src/github.js";
retry.delayMs = 0;
const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });

test("license: granted keys work; anything else doesn't; odd replies don't crash", async () => {
  const lic = (body, status = 200) => checkLicense("k:i", { fetchImpl: async () => reply(status, body), account: "acme" });
  assert.equal((await lic(POLAR_OK)).ok, true);
  assert.equal((await lic({ ...POLAR_OK, status: "revoked" })).ok, false);
  assert.match((await lic({ error: "ResourceNotFound", detail: "Not found" }, 404)).reason, /not active/);
  assert.equal((await lic({ detail: [{ msg: "bad" }] }, 422)).ok, false);
  assert.equal((await lic(null)).ok, false);                       // unreadable reply: no crash, not unlocked
  const html = await checkLicense("k:i", { fetchImpl: async () => ({ status: 403, json: async () => { throw new Error("html"); } }), account: "acme" });
  assert.equal(html.ok, false);                                      // a WAF/HTML error page is not a bypass
  const busy = await checkLicense(REAL_CODE, { fetchImpl: async () => ({ status: 429, json: async () => ({}) }), account: "acme" });
  assert.equal(busy.ok, true);                                       // rate limit: don't punish paying users
});

test("chains that loop never make a model its own replacement", async () => {
  const { writeFileSync: w } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  w(join(dir, "r.json"), JSON.stringify({ models: [
    { id: "a", retires: "2026-01-01", qualifier: "exact", replacement: "b" },
    { id: "b", retires: "2026-01-01", qualifier: "exact", replacement: "a" },
  ] }));
  const r = loadRegistry(join(dir, "r.json"));
  assert.notEqual(r.byId.get("a").replacement, "a");
  assert.notEqual(r.byId.get("b").replacement, "b");
});

test("o1 next to other model IDs counts; inference-profile ARNs resolve", () => {
  assert.deepEqual(scanText('const picker = ["o1", "gpt-4o"]', "a.ts", registry.byId).map((h) => h.id).sort(), ["gpt-4o", "o1"]);
  assert.equal(normalizeId("arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0"), "anthropic.claude-3-5-sonnet-20241022-v2:0");
});

test("a current model's empty answer keeps the replacement's answer", async () => {
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  const fetchImpl = async (url, opts) => {
    if (url.includes("api.polar.sh")) return reply(200, POLAR_OK);
    const model = JSON.parse(opts.body).model;
    return reply(200, model === "gpt-4" ? { output_text: "" } : { output_text: "hello" });
  };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl, env: { OPENAI_API_KEY: "x" } });
  assert.equal(r.drift[0].result, "changed");
  assert.equal(r.drift[0].after, "hello");
});

test("scanner stays fast on huge lines and skips bare o1 keys", () => {
  const t = Date.now();
  scanText(" " + "model".repeat(200000), "a.py");
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  assert.deepEqual(scanText('{"o1": "Option 1"}', "a.json", registry.byId), []);
  assert.deepEqual(scanText('model = "o1"', "a.py", registry.byId).map((h) => h.id), ["o1"]);
});

test("more ID spellings and file types", () => {
  assert.equal(normalizeId("claude-3-5-sonnet-v2@20241022"), "claude-3-5-sonnet-20241022");
  assert.equal(normalizeId("openrouter/openai/gpt-4"), "gpt-4");
  assert.equal(normalizeId("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0"), "anthropic.claude-3-5-sonnet-20240620-v1:0");
  assert.equal(normalizeId("azure/gpt-4"), "azure/gpt-4"); // Azure retires on its own dates
  const dir = tempRepo({ "App.vue": 'const m = "gpt-4"\n', "nb.ipynb": '{"source": ["model = \\"gpt-4\\""]}\n' });
  assert.equal(scanDirectory(dir).length, 2);
});

test("report: capped table, escaped HTML, answers left out of the issue", () => {
  const findings = Array.from({ length: 900 }, (_, i) => ({ id: `gpt-custom-${i}`, file: "a.py", line: i + 1, status: "unknown" }));
  const md = renderReport({ findings, registry, drift: [] });
  assert.ok(md.length < 60000);
  assert.match(md, /750 more model ID/);
  const d = [{ id: "p", from: "a", to: "b", result: "error", note: "<details open>", before: "secret", after: "secret" }];
  assert.ok(!renderReport({ findings: [], registry, drift: d }).includes("<details open>"));
  assert.ok(!renderReport({ findings: [], registry, drift: d, answers: false }).includes("secret"));
});

test("issue: closed with the all-clear when nothing is flagged", async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([opts.method || "GET", url, opts.body]);
    return url.includes("?") ? reply(200, [{ number: 7, title: "Driftline: AI model retirement report" }]) : reply(200, { number: 7, html_url: "u" });
  };
  const r = await upsertIssue("all clear", { token: "t", repo: "o/r", fetchImpl, close: true });
  assert.equal(r.closed, true);
  assert.match(calls[0][1], /per_page=100/);
  assert.equal(JSON.parse(calls[1][2]).state, "closed");
  const none = await upsertIssue("x", { token: "t", repo: "o/r", close: true, fetchImpl: async () => reply(200, []) });
  assert.ok(none.skipped);
});

test("run: license crash, empty prompt file, prompts: [] and .JSON never kill the scan", async () => {
  const boom = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  const r1 = await run({ root: boom, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl: async () => ({ status: 200, json: async () => { throw new TypeError("weird"); } }) });
  assert.equal(r1.findings.length, 1);
  for (const [name, text] of [["prompts.yml", "# nothing yet\n"], ["prompts.yml", "prompts: []\n"]]) {
    const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', [`.driftline/${name}`]: text });
    const r = await run({ root: dir, today: TODAY, registry });
    assert.ok(r.notices.some((n) => n.includes("has no prompts")), text);
  }
  const upper = tempRepo({ "p.JSON": '{"prompts":[{"id":"a","prompt":"hi"}]}' });
  assert.equal(loadPrompts(join(upper, "p.JSON")).length, 1);
});

test("providers: one retry when busy, and empty answers say why", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? reply(503, { error: { message: "busy" } }) : reply(200, { output_text: "hi" }));
  assert.equal(await complete({ model: "gpt-4", prompt: "x", env: { OPENAI_API_KEY: "k" }, fetchImpl: flaky }), "hi");
  assert.equal(n, 2);
  await assert.rejects(
    complete({ model: "gemini-2.0-flash", prompt: "x", env: { GEMINI_API_KEY: "k" }, fetchImpl: async () => reply(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }) }),
    /Empty answer \(SAFETY\)/);
  await assert.rejects(
    complete({ model: "claude-sonnet-5-5", prompt: "x", env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => reply(200, { stop_reason: "max_tokens", content: [{ type: "text", text: "{\"a\":" }] }) }),
    /cut off/);
});

// ---------- activation: 3 GitHub accounts per key ----------
import { activate, deactivate, parseCode, instanceName } from "../src/license.js";

test("activate prints a license code; the limit gives a clear way out", async () => {
  const sent = [];
  const ok = await activate(" DRIFTLINE-1 ", "Acme", { fetchImpl: async (url, opts) => {
    sent.push([url, JSON.parse(opts.body)]);
    return reply(200, { id: "act-9", label: "github:acme", license_key: { status: "granted", benefit_id: null, limit_activations: 3 } });
  } });
  assert.deepEqual([ok.ok, ok.code, ok.limit], [true, "DRIFTLINE-1:act-9", 3]);
  assert.match(sent[0][0], /api\.polar\.sh\/v1\/customer-portal\/license-keys\/activate$/);
  assert.deepEqual([sent[0][1].key, sent[0][1].label, sent[0][1].organization_id], ["DRIFTLINE-1", "github:acme", LICENSE.organizationId]);
  const full = await activate("DRIFTLINE-1", "acme", { fetchImpl: async () => reply(403, { error: "NotPermitted", detail: "License key activation limit already reached" }) });
  assert.equal(full.ok, false);
  assert.match(full.reason, /3 GitHub accounts.*deactivate/);
  assert.match((await activate("nope", "acme", { fetchImpl: async () => reply(404, { error: "ResourceNotFound", detail: "Not found" }) })).reason, /No such license key/);
  assert.equal((await activate("DRIFTLINE-1", "", {})).ok, false); // account unknown: ask for --account
  assert.match((await activate("DRIFTLINE-1", "acme", { fetchImpl: async () => { throw new TypeError("fetch failed"); } })).reason, /Could not reach/);
});

test("license code: must be activated, and for the account the workflow runs in", async () => {
  assert.deepEqual(parseCode("DRIFTLINE-a-b:inst-1"), { key: "DRIFTLINE-a-b", instanceId: "inst-1" });
  assert.equal(instanceName(" Acme "), "github:acme");
  const valid = (label) => async (url, opts) => {
    assert.equal(JSON.parse(opts.body).activation_id, "inst-1");
    return reply(200, { ...POLAR_OK, activation: label ? { id: "inst-1", label } : null });
  };
  assert.match((await checkLicense("plain-key", { fetchImpl: valid("github:acme"), account: "acme" })).reason, /not activated yet/);
  assert.equal((await checkLicense("k:inst-1", { fetchImpl: valid("github:acme"), account: "Acme" })).ok, true);
  const other = await checkLicense("k:inst-1", { fetchImpl: valid("github:acme"), account: "globex" });
  assert.equal(other.ok, false);
  assert.match(other.reason, /activated for "acme", not "globex"/);
  assert.match((await checkLicense("k:inst-1", { fetchImpl: valid(null), account: "acme" })).reason, /activation was removed/);
});

test("refunded or lapsed key: says Pro is not active, not \"activate again\"", async () => {
  // Polar answers 404 for a revoked/expired key and for a removed activation; asking about the key alone tells them apart.
  const polar = (keyGranted) => async (url, opts) => JSON.parse(opts.body).activation_id
    ? reply(404, { error: "ResourceNotFound", detail: "License key not found" })
    : keyGranted ? reply(200, { ...POLAR_OK, activation: null }) : reply(404, { error: "ResourceNotFound", detail: "License key not found" });
  const ended = await checkLicense("k:inst-1", { fetchImpl: polar(false), account: "acme" });
  assert.equal(ended.ok, false);
  assert.match(ended.reason, /not active.*Renew/);
  assert.doesNotMatch(ended.reason, /npx .* activate/);
  // Key still granted: the activation was freed, so activating again is the right advice.
  assert.match((await checkLicense("k:inst-1", { fetchImpl: polar(true), account: "acme" })).reason, /activation was removed.*activate/);
  const revoked = await activate("k", "acme", { fetchImpl: async () => reply(403, { error: "NotPermitted", detail: "License key is revoked" }) });
  assert.match(revoked.reason, /not active/);
});

test("deactivate frees a slot", async () => {
  let body;
  assert.equal((await deactivate("k:inst-1", { fetchImpl: async (url, opts) => { body = JSON.parse(opts.body); return { status: 204, json: async () => null }; } })).ok, true);
  assert.deepEqual([body.key, body.activation_id, body.organization_id], ["k", "inst-1", LICENSE.organizationId]);
  assert.match((await deactivate("k:inst-1", { fetchImpl: async () => reply(404, { error: "ResourceNotFound", detail: "x" }) })).reason, /no such activation/);
  assert.equal((await deactivate("k", {})).ok, false); // a bare key is not a license code
});

test("run: a code copied to another company runs the scan but not the drift tests", async () => {
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  let aiCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("api.polar.sh")) return reply(200, POLAR_OK);
    aiCalls++; return reply(200, { output_text: "hi" });
  };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "globex", fetchImpl, env: { OPENAI_API_KEY: "x" } });
  assert.equal(r.findings.length, 1);
  assert.equal(aiCalls, 0);
  assert.ok(r.notices.some((n) => n.includes('activated for "acme"')));
});

test("only keys for Driftline's Pro benefit unlock Pro", async () => {
  Object.assign(LICENSE, REAL_LICENSE);
  try {
    const sent = [];
    const key = (benefit_id) => checkLicense("k:i", { account: "acme", fetchImpl: async (url, opts) => {
      sent.push(JSON.parse(opts.body)); return reply(200, { ...POLAR_OK, benefit_id }); } });
    assert.equal((await key(REAL_LICENSE.benefitId)).ok, true);
    assert.deepEqual([sent[0].organization_id, sent[0].benefit_id], [REAL_LICENSE.organizationId, REAL_LICENSE.benefitId]); // Polar checks it too
    assert.match((await key("00000000-0000-4000-8000-000000000000")).reason, /different product/);
    assert.match((await key(undefined)).reason, /different product/);
  } finally {
    Object.assign(LICENSE, { benefitId: null });
  }
});

test("CLI: --help and --version answer instead of scanning a folder named after the flag", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const pkg = JSON.parse((await import("node:fs")).readFileSync(join(dirname(cli), "..", "package.json"), "utf8"));
  assert.equal(execFileSync("node", [cli, "--version"], { encoding: "utf8" }).trim(), pkg.version);
  assert.equal(execFileSync("node", [cli, "-v"], { encoding: "utf8" }).trim(), pkg.version);
  assert.match(execFileSync("node", [cli, "--help"], { encoding: "utf8" }), /Usage:[\s\S]*activate <license-key>/);
  const bad = spawnSync("node", [cli, "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option --nope/);
  assert.doesNotMatch(bad.stdout, /Scanned/);
});

test("Anthropic short names and OpenRouter dotted names map to the dated snapshot", () => {
  const today = new Date("2026-10-21T00:00:00Z");
  for (const raw of ["claude-sonnet-4-5", "claude-sonnet-4-5-latest", "anthropic/claude-sonnet-4.5", "openrouter/anthropic/claude-sonnet-4.5"]) {
    const c = classify(normalizeId(raw), registry, { today });
    assert.equal(c.status, "at-risk", raw);
    assert.equal(c.entry.aliasOf, "claude-sonnet-4-5-20250929", raw);
  }
  assert.equal(classify(normalizeId("claude-sonnet-4-0"), registry, { today }).status, "retired");
  assert.equal(classify(normalizeId("claude-3.5-sonnet"), registry, { today }).status, "retired");
  assert.equal(registry.models.some((m) => m.aliasOf), false); // aliases never count as listed models
  assert.equal(registry.byId.get("claude-sonnet-4-5-20250929").aliasOf, undefined);
});

test("report: Google model past its earliest date says it may already be off", () => {
  const today = new Date("2026-10-21T00:00:00Z");
  const c = classify("gemini-2.0-flash-001", registry, { today });
  const md = renderReport({ findings: [{ ...c, file: "a.py", line: 1 }], drift: [], registry });
  assert.match(md, /May already be off/);
  assert.doesNotMatch(md, /Retires soon/);
  const alias = classify("claude-sonnet-4-5", registry, { today });
  assert.match(renderReport({ findings: [{ ...alias, file: "a.py", line: 1 }], drift: [], registry }), /alias of `claude-sonnet-4-5-20250929`/);
});

test("routed Google models: switch date, not shutdown", () => {
  const before = classify("gemini-2.5-pro", registry, { today: new Date("2026-11-11T00:00:00Z") });
  assert.equal(before.status, "at-risk");
  assert.match(renderReport({ findings: [{ ...before, file: "a.py", line: 1 }], drift: [], registry }), /Switches model soon.*routing starts/);
  const after = classify("gemini-2.5-flash", registry, { today: new Date("2026-12-02T00:00:00Z") });
  assert.equal(after.status, "retired");
  const md = renderReport({ findings: [{ ...after, file: "a.py", line: 1 }], drift: [], registry });
  assert.match(md, /Now answered by the replacement/);
  assert.match(md, /gemini-3\.5-flash-lite/);
  assert.ok(registry.byId.has("gemini-2.5-flash-preview-09-2025"));
});

test("only whole-version Claude names get the -0 alias", () => {
  assert.ok(registry.byId.has("claude-opus-4-0"));
  assert.equal(registry.byId.has("claude-sonnet-4-5-0"), false);
  assert.equal(registry.byId.has("claude-opus-4-1-0"), false);
});

test("CLI --json prints machine-readable findings", async () => {
  const { execFileSync } = await import("node:child_process");
  let out;
  try { out = execFileSync(process.execPath, [join(here, "..", "src", "cli.js"), SAMPLE, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, DRIFTLINE_LICENSE_KEY: "" } }); }
  catch (e) { out = e.stdout; } // exit 1 when the sample uses a retired model
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.findings) && data.findings.length > 0);
  assert.ok(data.findings.every((f) => f.id && f.file && f.status));
});

test("MCP tools: check, scan, upcoming", async () => {
  const { callTool } = await import("../src/mcp.js");
  const ctx = { reg: registry, source: "bundled", today: TODAY };
  const c = await callTool("check_models", { ids: ["models/gemini-2.0-flash", "claude-sonnet-4-5", "not-a-model"] }, ctx);
  assert.equal(c.models[0].normalized, "gemini-2.0-flash");
  assert.ok(c.models[0].retires && c.models[0].advice);
  assert.equal(c.models[1].alias_of, "claude-sonnet-4-5-20250929");
  assert.equal(c.models[2].status, "unknown");
  assert.match(c.next_step, /aidriftline\.com\/#drift/);
  const fine = await callTool("check_models", { ids: ["not-a-model"] }, ctx);
  assert.equal(fine.next_step, undefined);
  const s = await callTool("scan_project", { path: SAMPLE }, ctx);
  assert.match(s.next_step, /Driftline Pro/);
  assert.ok(s.flagged > 0 && s.findings.every((f) => f.file && f.line && !["active", "unknown"].includes(f.status)));
  const u = await callTool("upcoming_retirements", { days: 60, provider: "openai" }, ctx);
  assert.ok(u.models.every((m) => m.provider === "openai" && m.days_left > 0 && m.days_left <= 60));
  await assert.rejects(callTool("check_models", { ids: [] }, ctx));
  await assert.rejects(callTool("scan_project", { path: "/no/such/folder" }, ctx), /Not a folder/);
});

test("MCP server answers JSON-RPC over stdio", async () => {
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, [join(here, "..", "src", "cli.js"), "mcp"], { env: { ...process.env, DRIFTLINE_OFFLINE: "1" } });
  const lines = [];
  let buf = "";
  const done = new Promise((ok) => p.stdout.on("data", (d) => {
    buf += d; const parts = buf.split("\n"); buf = parts.pop(); lines.push(...parts);
    if (lines.length >= 3) ok();
  }));
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_models", arguments: { ids: ["gpt-5"] } } },
  ];
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await done;
  p.kill();
  const [init, list, call] = lines.map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
  assert.equal(init.result.serverInfo.name, "driftline");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["check_models", "scan_project", "upcoming_retirements"]);
  assert.equal(call.result.structuredContent.registry_source, "bundled");
  assert.equal(call.result.structuredContent.models[0].replacement, "gpt-6.1-sol");
});

// ---------- replacement notes (provider instructions that go with the replacement) ----------
test("registry: gpt-5/o3 replacements follow OpenAI's 13 Nov 2026 page; pro models carry the mode note", async () => {
  const { replacementText } = await import("../src/registry.js");
  const at = (id) => registry.byId.get(id);
  assert.equal(at("gpt-5").replacement, "gpt-6.1-sol");
  assert.equal(at("gpt-5-mini").replacement, "gpt-6.1-terra");
  assert.equal(at("gpt-5-nano-2025-08-07").replacement, "gpt-6-luna");
  assert.equal(at("o3-pro").replacement, "gpt-6.1-sol");
  assert.equal(replacementText(at("o3-pro")), "gpt-6.1-sol (reasoning.mode: pro, in the Responses API)");
  assert.equal(replacementText(at("o3")), "gpt-6.1-sol");
  assert.equal(at("gpt-4-completions").retires, "2026-10-23");
});

test("run: drift test on a pro model runs the replacement in pro mode, as the provider says", async () => {
  const dir = tempRepo({ "a.py": 'm = "o3-pro"\n', ".driftline/prompts.yml": "prompts:\n  - id: p\n    prompt: hi\n" });
  const bodies = [];
  const fetchImpl = async (url, opts) => { if (!url.includes("api.polar.sh")) bodies.push(JSON.parse(opts.body)); return licensed("hi")(url, opts); };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl, env: { OPENAI_API_KEY: "x" } });
  const d = r.drift.find((x) => x.id === "p");
  assert.equal(d.to, "gpt-6.1-sol");
  assert.deepEqual(bodies.find((b) => b.model === "gpt-6.1-sol").reasoning, { mode: "pro" });
  assert.equal(bodies.find((b) => b.model === "o3-pro").reasoning, undefined, "the current model is called as before");
  assert.match(d.note, /tested with reasoning\.mode: pro/);
  assert.doesNotMatch(d.note, /Tested without/);
  assert.match(r.markdown, /gpt-6\.1-sol` \(reasoning\.mode: pro, in the Responses API\)/);
  // With an explicit compare_to the customer chose the target: no mode, no caveat.
  const dir2 = tempRepo({ "a.py": 'm = "o3-pro"\n', ".driftline/prompts.yml": "prompts:\n  - id: p\n    prompt: hi\n    compare_to: gpt-6.1-sol\n" });
  bodies.length = 0;
  const r2 = await run({ root: dir2, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl, env: { OPENAI_API_KEY: "x" } });
  assert.equal(bodies.find((b) => b.model === "gpt-6.1-sol").reasoning, undefined);
  assert.doesNotMatch(r2.drift.find((x) => x.id === "p").note || "", /reasoning/);
});

test("report and drift notes say when a replacement is more than a rename", async () => {
  const dir = tempRepo({ "a.py": 'm = "gemini-2.0-flash"\nt = "tts-1"\ng = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: p\n    model: gemini-2.0-flash\n    prompt: hi\n" });
  const fetchImpl = async (url, opts) => url.includes("api.polar.sh") ? licensed("hi")(url, opts)
    : { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "acme", fetchImpl, env: { GEMINI_API_KEY: "x", GOOGLE_API_KEY: "x" } });
  assert.match(r.markdown, /\| Change needed \|/);
  assert.match(r.markdown, /⚠️ Parameter changes \[\d\]/);
  assert.match(r.markdown, /⚠️ API change \[\d\]/);
  assert.match(r.markdown, /✅ Rename/);
  assert.match(r.markdown, /\*\*More than a rename:\*\*/);
  assert.match(r.markdown, /thinking_budget with thinking_level/);
  const d = r.drift.find((x) => x.id === "p");
  assert.match(d.note || "", /Beyond the model name: Gemini 3 changes the request/);
});


test("replacement changes are remembered and shown for 120 days", async () => {
  const { replacementChange } = await import("../src/registry.js");
  const e = registry.byId.get("gpt-5-mini");
  assert.deepEqual(replacementChange(e, new Date("2026-11-20T00:00:00Z")), { on: "2026-11-13", was: "gpt-5.6-terra", days: 7 });
  assert.equal(replacementChange(e, new Date("2026-11-01T00:00:00Z")), null, "not before the change");
  assert.equal(replacementChange(e, new Date("2027-04-01T00:00:00Z")), null, "not after 120 days");
  assert.equal(replacementChange(registry.byId.get("gpt-4"), new Date("2026-11-20T00:00:00Z")), null);

  const dir = tempRepo({ "a.py": 'm = "gpt-5-mini"\n', ".driftline/prompts.yml": "prompts:\n  - id: p\n    prompt: hi\n" });
  const r = await run({ root: dir, today: new Date("2026-11-20T00:00:00Z"), registry, licenseKey: "k:i", account: "acme", fetchImpl: licensed("hi"), env: { OPENAI_API_KEY: "x" } });
  assert.match(r.drift.find((x) => x.id === "p").note, /changed this replacement on 2026-11-13 \(before: gpt-5\.6-terra\)/);
  assert.match(r.markdown, /changed 2026-11-13, was `gpt-5\.6-terra`/);
});

test("live registry is used when valid and at least as new; otherwise the bundled copy", async () => {
  const { loadBestRegistry, validRegistry } = await import("../src/registry.js");
  const bundled = JSON.parse((await import("node:fs")).readFileSync(new URL("../registry/models.json", import.meta.url), "utf8"));
  const serve = (data) => async () => ({ ok: true, json: async () => data });
  const newer = { ...bundled, checked: "2099-01-01", models: bundled.models.map((m) => m.id === "gpt-4" ? { ...m, replacement: "live-only-model" } : m) };
  let r = await loadBestRegistry({ fetchImpl: serve(newer), offline: false });
  assert.equal(r.source, "live");
  assert.equal(r.reg.byId.get("gpt-4").replacement, "live-only-model");
  assert.equal(r.reg.source, "live");
  r = await loadBestRegistry({ fetchImpl: serve({ ...newer, checked: "2000-01-01" }), offline: false });
  assert.equal(r.source, "bundled", "older live copy is ignored");
  r = await loadBestRegistry({ fetchImpl: serve({ checked: "2099-01-01", models: [{ id: 1 }] }), offline: false });
  assert.equal(r.source, "bundled", "malformed live copy is ignored");
  r = await loadBestRegistry({ fetchImpl: async () => { throw new TypeError("fetch failed"); }, offline: false });
  assert.equal(r.source, "bundled", "network error falls back");
  r = await loadBestRegistry({ fetchImpl: serve(newer), offline: true });
  assert.equal(r.source, "bundled", "registry: bundled never fetches");
  assert.equal(validRegistry(bundled), true);
});

// ---------- migration notes: is the replacement a drop-in? ----------
test("migrationFor: rename, settings, params, api, re-embed, choose", async () => {
  const { migrationFor } = await import("../src/migration.js");
  const at = (id) => migrationFor(registry.byId.get(id));
  assert.equal(at("gpt-4").change, "rename");
  assert.equal(at("gpt-4").drop_in, true);
  assert.equal(at("o3-pro").change, "settings");
  assert.match(at("o3-pro").note, /reasoning\.mode: pro/);
  assert.equal(at("davinci-002").change, "api");
  assert.equal(at("gpt-4-completions").change, "api");
  assert.equal(at("tts-1").change, "api");
  assert.equal(at("gpt-4o-realtime-preview").change, "api");
  assert.equal(at("whisper-1").change, "choose");
  assert.match(at("whisper-1").note, /gpt-transcribe for recorded files/);
  assert.equal(at("gemini-2.5-pro").change, "params", "routed Gemini 2.x still needs the Gemini 3 request changes");
  assert.match(at("gemini-2.5-pro").guide, /whats-new-gemini-3\.8/);
  assert.equal(at("gemini-2.0-flash").change, "params");
  assert.equal(at("gemini-3-pro-preview").change, "rename");
  assert.equal(at("imagen-4.0-generate-001").change, "api");
  assert.equal(at("veo-3.1-generate-preview").change, "api");
  assert.equal(at("text-embedding-004").change, "re-embed");
  assert.equal(at("claude-sonnet-4-5-20250929").change, "params");
  assert.equal(at("claude-3-haiku-20240307").change, "rename", "Haiku 4.5 still takes sampling settings");
  assert.equal(at("gpt-image-1.5").change, "rename");
  assert.match(at("gpt-image-1.5").note, /flare/);
  assert.equal(migrationFor(registry.byId.get("sora-2")), null, "no replacement, no migration");
});

test("two replacements ('X or Y') are both shown, also through a chain", async () => {
  const { replacementText } = await import("../src/registry.js");
  assert.equal(replacementText(registry.byId.get("whisper-1")), "gpt-live-transcribe or gpt-transcribe");
  assert.equal(replacementText(registry.byId.get("gpt-4o-mini-transcribe-2025-03-20")), "gpt-live-transcribe or gpt-transcribe", "carried along the chain");
  assert.equal(replacementText(registry.byId.get("gpt-image-1.5")), "gpt-image-2.6-sunburst or gpt-image-2.6-flare");
  assert.equal(registry.byId.get("gpt-4").replacement_alt, undefined);
  const dir = tempRepo({ "a.py": 'm = "whisper-1"\n' });
  const r = await run({ root: dir, today: TODAY, registry });
  assert.match(r.markdown, /`gpt-live-transcribe` or `gpt-transcribe`/);
});

test("an entry under review says so in the report instead of stating its date as fact", async () => {
  const { buildRegistry, reviewText } = await import("../src/registry.js");
  const data = JSON.parse((await import("node:fs")).readFileSync(new URL("../registry/models.json", import.meta.url), "utf8"));
  const flagged = { ...data, models: data.models.map((m) => m.id === "gpt-4" ? { ...m, under_review: { since: "2026-11-14", what: "date", page: "https://developers.openai.com/api/docs/deprecations" } } : m) };
  const reg = buildRegistry(flagged);
  assert.match(reviewText(reg.byId.get("gpt-4")), /^Under review: OpenAI's page no longer matches the date shown here \(since 2026-11-14\)/);
  assert.equal(reviewText(reg.byId.get("gpt-4o-2024-05-13")), "");
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n' });
  const r = await run({ root: dir, today: TODAY, registry: reg });
  assert.match(r.markdown, /· 🔍 under review \|/);
  assert.match(r.markdown, /\*\*🔍 Under review:\*\*/);
});

// Amazon Bedrock sets its own dates per model and region; they win over the model maker's dates for Bedrock IDs.
const BEDROCK = { models: [{ id: "claude-opus-4-1-20250805", provider: "anthropic", retires: "2026-08-05", qualifier: "exact", replacement: "claude-opus-4-8" }],
  checked: "2026-11-14", sources: {}, platforms: { bedrock: { name: "Amazon Bedrock", source: "https://docs.aws.amazon.com/x", models: [
    { id: "anthropic.claude-opus-4-1-20250805-v1:0", maker: "anthropic", kind: "text", retires: "2027-01-08", legacy: "2026-07-08", extended: "2026-10-08",
      regions: [{ regions: ["us-east-1"], legacy: "2026-07-08", retires: "2027-01-08", extended: "2026-10-08" }] },
    { id: "meta.llama3-70b-instruct-v1:0", maker: "meta", kind: "text", retires: "2027-03-30", legacy: "2026-09-30",
      regions: [{ regions: ["us-east-1"], legacy: "2026-09-30", retires: "2027-03-30" }, { regions: ["us-gov-west-1"], legacy: "2026-11-09", retires: "2027-05-09" }] },
  ] } } };

test("Bedrock IDs use Bedrock's dates, not the model maker's", async () => {
  const { buildRegistry, platformText } = await import("../src/registry.js");
  const reg = buildRegistry(BEDROCK);
  const today = new Date("2026-11-14T00:00:00Z");
  const onBedrock = classify(normalizeId("us.anthropic.claude-opus-4-1-20250805-v1:0"), reg, { today });
  assert.equal(onBedrock.status, "at-risk"); // 55 days on Bedrock, though Anthropic's own API retired it in August
  assert.equal(onBedrock.entry.retires, "2027-01-08");
  assert.equal(onBedrock.entry.replacement, "claude-opus-4-8"); // Anthropic's, marked as such
  assert.match(platformText(onBedrock.entry, today), /Amazon Bedrock.*extended access since 2026-10-08/);
  assert.equal(classify("claude-opus-4-1-20250805", reg, { today }).status, "retired");
  const llama = classify(normalizeId("bedrock/meta.llama3-70b-instruct-v1:0"), reg, { today });
  assert.equal(llama.status, "deprecated");
  assert.match(platformText(llama.entry, today), /latest is 2027-05-09/);
  // A Bedrock model not on Bedrock's list has no announced date there, whatever the maker says.
  assert.equal(classify(normalizeId("anthropic.claude-sonnet-5-5-v1:0"), reg, { today }).status, "unknown");
  assert.deepEqual(scanText('modelId: "eu.anthropic.claude-opus-4-1-20250805-v1:0"', "a.ts", reg.byId).map((h) => h.id), ["anthropic.claude-opus-4-1-20250805-v1:0"]);
  // Older versions accept only OpenAI/Anthropic/Google in `models`; platform data must not break that.
  const { validRegistry } = await import("../src/registry.js");
  assert.equal(validRegistry({ ...BEDROCK, models: Array(50).fill(BEDROCK.models[0]) }), true);
});

test("Bedrock page parser reads single and multi-region blocks", async () => {
  const { parseBedrock } = await import("../tools/bedrock.mjs");
  const md = `**Models with a scheduled EOL date**
- **Meta**
  - **Model name:** Llama 3 70B Instruct
  - **Model ID:** meta.llama3-70b-instruct-v1:0
  - **Regions:** ap-south-1, us-east-1 / **Legacy date:** September 30, 2026 / **EOL date:** March 30, 2027 / **Public extended access start date:** To be announced
  - **Regions:** us-gov-west-1 / **Legacy date:** November 9, 2026 / **EOL date:** May 9, 2027 / **Public extended access start date:** To be announced
- **DeepSeek**
  - **Model name:** DeepSeek-V3.1
  - **Model ID:** deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-mantle)
  - **Regions:** us-west-2
  - **Legacy date:** September 30, 2026
  - **EOL date:** March 30, 2027
  - **Public extended access start date:** —
**Models that have reached EOL**
- **Cohere**
  - **Model name:** Command R\\+
  - **Model ID:** cohere.command-r-plus-v1:0
  - **Regions:** us-east-1
  - **Legacy date:** February 19, 2026
  - **EOL date:** August 19, 2026
  - **Public extended access start date:** May 19, 2026
`;
  const out = parseBedrock(md);
  assert.deepEqual(out.map((m) => m.id), ["cohere.command-r-plus-v1:0", "deepseek.v3-v1:0", "deepseek.v3.1", "meta.llama3-70b-instruct-v1:0"]);
  const llama = out.find((m) => m.id.startsWith("meta."));
  assert.equal(llama.retires, "2027-03-30");
  assert.equal(llama.regions.length, 2);
  assert.equal(out[0].extended, "2026-05-19");
  assert.equal(out[0].name, "Command R+");
});

// Google Vertex AI uses the Gemini API's model names with its own dates; the file's code decides which apply.
const VERTEX = { models: [
    { id: "gemini-2.5-pro", provider: "google", retires: "2026-12-01", qualifier: "exact", routes: true, replacement: "gemini-3.5-flash" },
    { id: "claude-3-5-sonnet-20241022", provider: "anthropic", retires: "2025-10-22", qualifier: "exact", replacement: "claude-sonnet-5-5" },
  ], checked: "2026-11-14", sources: {}, platforms: { vertex: { name: "Vertex AI", source: "https://x/versions", sources: { gemini: "https://x/versions", partner: "https://x/partner" }, models: [
    { id: "gemini-2.5-pro", maker: "google", kind: "text", retires: "2026-10-20", replacement: "gemini-3.8-flash", page: "gemini" },
    { id: "gemini-3.6-flash", maker: "google", kind: "text", retires: "2026-11-19", replacement: "gemini-3.8-flash", page: "gemini" },
    { id: "claude-3-5-sonnet-v2", maker: "anthropic", kind: "text", retires: "2026-02-19", page: "partner" },
    { id: "deepseek-r1-0528-maas", maker: "deepseek", kind: "text", retires: "2026-10-21", page: "open" },
  ] } } };

test("Vertex dates apply when the file shows Vertex signs or the ID is written the Vertex way", async () => {
  const { buildRegistry, resolveId, vertexNote, shownId } = await import("../src/registry.js");
  const reg = buildRegistry(VERTEX);
  const today = new Date("2026-11-14T00:00:00Z");
  const vertexFile = 'client = genai.Client(vertexai=True)\nresp = client.models.generate_content(model="gemini-2.5-pro")';
  const apiFile = 'client = genai.Client(api_key=k)\nresp = client.models.generate_content(model="gemini-2.5-pro")';
  const onVertex = scanText(vertexFile, "v.py", reg.byId), onApi = scanText(apiFile, "a.py", reg.byId);
  assert.deepEqual(onVertex.map((h) => h.id), ["vertex:gemini-2.5-pro"]);
  assert.deepEqual(onApi.map((h) => h.id), ["gemini-2.5-pro"]);
  assert.equal(classify(onVertex[0].id, reg, { today }).status, "retired"); // calls fail on Vertex since 20 Oct
  assert.equal(classify(onApi[0].id, reg, { today }).entry.routes, true); // Gemini API re-routes on 1 Dec
  assert.match(vertexNote(reg.byId.get("gemini-2.5-pro"), today), /retired 2026-10-20/);
  assert.equal(shownId("vertex:gemini-2.5-pro"), "gemini-2.5-pro (Vertex AI)");
  // Vertex spellings need no file signs: Claude's @date, vertex_ai/ prefix, MaaS IDs.
  assert.equal(resolveId("claude-3-5-sonnet-v2@20241022", reg), "vertex:claude-3-5-sonnet-v2");
  assert.equal(resolveId("vertex_ai/gemini-2.5-pro", reg), "vertex:gemini-2.5-pro");
  assert.equal(resolveId("deepseek-r1-0528-maas", reg), "vertex:deepseek-r1-0528-maas");
  // Claude on Vertex: Vertex names no replacement, Anthropic's is passed on and marked.
  assert.equal(reg.byId.get("vertex:claude-3-5-sonnet-v2").replacement_from, "anthropic");
  // A Gemini ID Vertex lists but the Gemini API doesn't retire keeps no date outside Vertex code.
  assert.equal(classify("gemini-3.6-flash", reg, { today }).status, "unknown");
  assert.equal(classify("deepseek-r1-0528-maas", reg, { today }).status, "retired"); // exists only on Vertex
});

test("Vertex page parsers read tables, partner paragraphs and MaaS tables", async () => {
  const { parseGemini, parsePartner, parseOpen } = await import("../tools/vertex.mjs");
  const g = parseGemini(`<h3>Gemini models</h3><table><tr><th>Model ID</th></tr>
    <tr><td><code>gemini-2.5-pro</code></td><td>June 17, 2025</td><td>October 20, 2026</td><td>gemini-3.8-flash or gemini-3.5-flash</td></tr>
    <tr><td><code>gemini-3.8-flash</code></td><td>September 2, 2026</td><td>September 2, 2027 or later</td><td></td></tr></table>
    <h3>Embeddings models</h3><table><tr><td>text-embedding-005</td><td>November 18, 2024</td><td>April 1, 2027</td><td></td></tr>
    <tr><td>gemini-embedding-001</td><td>May 20, 2025</td><td>No sooner than May 20, 2028</td><td></td></tr></table>`);
  assert.deepEqual(g.map((m) => [m.id, m.retires, m.kind, m.replacement || null, m.replacement_alt || null]), [
    ["gemini-2.5-pro", "2026-10-20", "text", "gemini-3.8-flash", "gemini-3.5-flash"], ["text-embedding-005", "2027-04-01", "embedding", null, null]]);
  const p = parsePartner(`<article><h2>Anthropic's Claude 3 Haiku on Google Cloud</h2><p>Anthropic's Claude 3 Haiku on Google Cloud is <strong>deprecated as of February 23, 2026</strong> and will
    be <strong>shut down on August 23, 2026</strong>.</p><table><tr><td>Model ID</td><td>claude-3-haiku</td></tr></table></article>`);
  assert.deepEqual(p.map((m) => [m.id, m.maker, m.retires]), [["claude-3-haiku", "anthropic", "2026-08-23"]]);
  const o = parseOpen(`<table><tr><td>llama-3.3-70b-instruct-maas</td><td>July 21, 2026</td><td>October 21, 2026</td><td>Self-deploy</td></tr></table>`);
  assert.deepEqual(o.map((m) => [m.id, m.maker, m.retires]), [["llama-3.3-70b-instruct-maas", "meta", "2026-10-21"]]);
});

// Microsoft Azure: its own date per model version; files with Azure signs use them.
const AZURE = { models: [
    { id: "o3", provider: "openai", retires: "2026-12-11", qualifier: "exact", replacement: "gpt-6.1-sol" },
    { id: "gpt-4o-2024-05-13", provider: "openai", retires: "2026-10-23", qualifier: "exact", replacement: "gpt-5.1" },
  ], checked: "2026-11-14", sources: {}, platforms: { azure: { name: "Azure", source: "https://x/azure", models: [
    { id: "o3", name: "o3", maker: "openai", kind: "text", retires: "2026-11-19", replacement: "gpt-5.6-sol", versions: [{ version: "2025-04-16", lifecycle: "Deprecated", retires: "2026-11-19", replacement: "gpt-5.6-sol" }] },
    { id: "gpt-4o", name: "gpt-4o", maker: "openai", kind: "text", retires: "2027-01-14", replacement: "gpt-5.1", versions: [
      { version: "2024-05-13", lifecycle: "Deprecated", retires: "2027-01-14", replacement: "gpt-5.1" },
      { version: "2024-08-06", lifecycle: "Deprecated", retires: "2027-04-14", replacement: "gpt-5.1" }] },
    { id: "gpt-5.1", name: "gpt-5.1", maker: "openai", kind: "text", retires: "2027-07-13", versions: [{ version: "2025-11-13", lifecycle: "GA", retires: "2027-07-13" }] },
  ] } } };

test("Azure dates apply in Azure files, per model version; api_version is never a model version", async () => {
  const { buildRegistry, vertexNote, platformText } = await import("../src/registry.js");
  const reg = buildRegistry(AZURE);
  const today = new Date("2026-11-14T00:00:00Z");
  const app = 'client = AzureOpenAI(azure_endpoint=e, api_version="2024-08-06")\nr = client.chat.completions.create(model="gpt-4o")\no = "o3"\nn = "gpt-5.1"';
  const ids = scanText(app, "app.py", reg.byId).map((h) => h.id);
  assert.deepEqual(ids, ["azure:gpt-4o", "azure:o3", "azure:gpt-5.1"]); // api_version next to it is not the model version
  const bicep = "resource d 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {\n  model: {\n    name: 'gpt-4o'\n    version: '2024-08-06'\n  }\n}";
  assert.deepEqual(scanText(bicep, "main.bicep", reg.byId).map((h) => h.id), ["azure:gpt-4o@2024-08-06"]);
  assert.equal(classify("azure:o3", reg, { today }).status, "at-risk"); // 19 Nov on Azure, 11 Dec on OpenAI's API
  assert.equal(classify("azure:gpt-4o@2024-08-06", reg, { today }).entry.retires, "2027-04-14");
  assert.equal(classify("azure:gpt-5.1", reg, { today }).status, "active"); // GA: Azure plans every model's end, not a deprecation
  assert.match(platformText(reg.byId.get("azure:gpt-4o"), today), /2024-05-13 → 2027-01-14, 2024-08-06 → 2027-04-14/);
  // OpenAI's own entries mention Azure's date; plain OpenAI files keep OpenAI's date.
  assert.deepEqual(scanText('r = client.responses.create(model="o3")', "plain.py", reg.byId).map((h) => h.id), ["o3"]);
  assert.match(vertexNote(reg.byId.get("o3"), today), /On Azure the date differs: retires 2026-11-19/);
  assert.match(vertexNote(reg.byId.get("gpt-4o-2024-05-13"), today), /retires 2027-01-14 \(version 2024-05-13\)/);
  assert.equal(scanText('m = "azure/o3"', "x.py", reg.byId)[0].id, "azure:o3");
});

test("Azure page parser reads the per-maker tables and skips fine-tuned ones", async () => {
  const { parseAzure } = await import("../tools/azure.mjs");
  const out = parseAzure(`<h3>Azure OpenAI</h3><table><thead><tr><th>Model</th><th>Version</th><th>Lifecycle</th><th>Retirement date</th><th>Replacement</th></tr></thead>
    <tr><td>gpt-4o</td><td>2024-08-06</td><td>Deprecated</td><td>2027-04-14<sup>3</sup></td><td>gpt-5.1</td></tr>
    <tr><td>gpt-4o</td><td>2024-05-13</td><td>Deprecated</td><td>2027-01-14</td><td>gpt-5.1 (2025-11-13)</td></tr>
    <tr><td>gpt-4.1</td><td>2025-04-14</td><td>Deprecated</td><td>No earlier than 2027-04-14</td><td>—</td></tr></table>
    <h4>Fine-tuned models</h4><table><tr><th>Model</th><th>Version</th><th>Training retirement date</th><th>Deployment retirement date</th></tr><tr><td>gpt-4o</td><td>2024-08-06</td><td>2027-04-01</td><td>2027-10-01</td></tr></table>
    <h3>Anthropic</h3><table><tr><th>Model</th><th>Version</th><th>Lifecycle</th><th>Retirement date</th><th>Replacement</th></tr><tr><td>claude-mythos-preview (gated research preview)</td><td>—</td><td>Preview</td><td>2027-04-02</td><td>—</td></tr></table>`);
  assert.deepEqual(out.map((m) => [m.id, m.maker, m.retires, m.replacement || null, m.versions.length]), [
    ["claude-mythos-preview", "anthropic", "2027-04-02", null, 1], ["gpt-4o", "openai", "2027-01-14", "gpt-5.1", 2]]);
});

// More providers' own pages (Groq, Mistral, xAI, Cohere, DeepSeek). Ambiguous IDs need the provider's signs in the file.
const DIRECT = { models: Array(0), checked: "2026-11-14", sources: {}, platforms: {
  groq: { name: "Groq", direct: true, source: "https://x/groq", models: [
    { id: "qwen/qwen3-32b", maker: "qwen", kind: "text", retires: "2026-07-17", replacement: "openai/gpt-oss-120b" },
    { id: "llama-3.3-70b-versatile", maker: "meta", kind: "text", retires: "2026-08-16", replacement: "openai/gpt-oss-120b" }] },
  cohere: { name: "Cohere", direct: true, source: "https://x/cohere", models: [
    { id: "command", maker: "cohere", kind: "text", retires: "2025-09-15", replacement_note: "Cohere suggests command-a-03-2025" },
    { id: "command-r-plus-04-2024", maker: "cohere", kind: "text", retires: "2025-09-15" }] },
  xai: { name: "xAI", direct: true, source: "https://x/xai", models: [
    { id: "grok-3", maker: "xai", kind: "text", retires: "2026-05-15", routes: true, replacement: "grok-4.3", replacement_note: "reasoning_effort: none" }] },
} };

test("provider IDs: distinctive ones anywhere, ambiguous ones only with the provider's signs", async () => {
  const { buildRegistry, replacementText } = await import("../src/registry.js");
  const reg = buildRegistry(DIRECT);
  const today = new Date("2026-11-14T00:00:00Z");
  assert.deepEqual(scanText('from groq import Groq\nm = "qwen/qwen3-32b"\nn = "llama-3.3-70b-versatile"', "g.py", reg.byId).map((h) => h.id), ["groq:qwen/qwen3-32b", "groq:llama-3.3-70b-versatile"]);
  assert.deepEqual(scanText('fetch("https://openrouter.ai/api/v1", { model: "qwen/qwen3-32b" })', "o.ts", reg.byId).map((h) => h.id), []); // OpenRouter's qwen/qwen3-32b is not Groq's
  assert.deepEqual(scanText('m = "llama-3.3-70b-versatile"', "x.py", reg.byId).map((h) => h.id), ["llama-3.3-70b-versatile"]); // Groq-only name
  assert.deepEqual(scanText('const parts = ["command", "subcommand"]', "cli.js", reg.byId).map((h) => h.id), []); // the word "command" is not Cohere's model
  assert.deepEqual(scanText('import cohere\nr = co.chat(model="command")', "c.py", reg.byId).map((h) => h.id), ["cohere:command"]);
  assert.equal(scanText('m = "groq/qwen/qwen3-32b"', "l.py", reg.byId)[0].id, "groq:qwen/qwen3-32b"); // LiteLLM-style prefix
  assert.equal(replacementText(reg.byId.get("cohere:command")), "Cohere suggests command-a-03-2025");
  const grok = classify("grok-3", reg, { today });
  assert.equal(grok.status, "retired");
  assert.equal(grok.entry.routes, true); // xAI redirects old slugs to grok-4.3
  const { validRegistry } = await import("../src/registry.js");
  assert.equal(validRegistry({ ...DIRECT, models: Array(50).fill({ id: "o3", provider: "openai", retires: "2026-12-11" }) }), true); // older versions still read the list
});

test("provider page parsers: Groq tables, Mistral markdown, xAI guides, Cohere notes", async () => {
  const { parseGroq, parseMistral, parseXaiGuide, parseCohere } = await import("../tools/direct.mjs");
  assert.deepEqual(parseGroq(`<table><tr><th>Deprecated Model</th><th>Shutdown Date</th><th>Recommended Replacement Model ID</th></tr>
    <tr><td>llama-3.3-70b-versatile</td><td>08/16/26</td><td>openai/gpt-oss-120b or qwen/qwen3.6-27b</td></tr></table>`).map((m) => [m.id, m.retires, m.replacement, m.replacement_alt]),
    [["llama-3.3-70b-versatile", "2026-08-16", "openai/gpt-oss-120b", "qwen/qwen3.6-27b"]]);
  const md = `| Model | API name | Status |\n| --- | --- | --- |\n| [Mistral Large 4](/models/x) | \`mistral-large-4\` | GA |\n\n## Deprecated and retired models\n\n| Model | API name | Status | Context | Summary | Deprecation | Retirement | Replacement |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| [Mistral Large 3](/models/y) | \`mistral-large-2512\` | Deprecated | 256k | x | 2026-10-31 | 2027-04-30 | [Mistral Large 4](/models/x) |\n`;
  assert.deepEqual(parseMistral(md).map((m) => [m.id, m.retires, m.replacement]), [["mistral-large-2512", "2027-04-30", "mistral-large-4"]]);
  const g = parseXaiGuide("# Grok Model Retirement on May 15, 2026\n\n| Model being retired | Redirect target |\n|---|---|\n| `grok-3` | `grok-4.3` with `none` reasoning effort |\n");
  assert.deepEqual(g.map((m) => [m.id, m.retires, m.routes, m.replacement, m.replacement_note]), [["grok-3", "2026-05-15", true, "grok-4.3", "reasoning_effort: none"]]);
  const c = parseCohere("### 2025-09-15: Old models\n\nEffective September 15, 2025, the following deprecations will roll out.\n\nDeprecated Models:\n\n* `command-r-03-2024`  (and the alias `command-r`)\n* `summarize` (endpoint)\n\nFor command model replacements, we recommend you use `command-r-08-2024` or `command-a-03-2025`.\n");
  assert.deepEqual(c.map((m) => [m.id, m.retires, m.replacement_note]), [["command-r", "2025-09-15", "Cohere suggests command-r-08-2024 or command-a-03-2025"], ["command-r-03-2024", "2025-09-15", "Cohere suggests command-r-08-2024 or command-a-03-2025"]]);
});

// `driftline fix`: renames only where a rename is the whole change; everything else is listed, nothing else touched.
test("fix replaces plain renames, keeps prefixes, skips the rest with a reason", async () => {
  const { buildRegistry } = await import("../src/registry.js");
  const { planFixes, applyFixes } = await import("../src/fix.js");
  const reg = buildRegistry({ checked: "2026-11-14", sources: {}, models: [
    { id: "gpt-4-0613", provider: "openai", retires: "2026-06-06", qualifier: "exact", replacement: "gpt-4.1" },
    { id: "gemini-2.0-flash", provider: "google", retires: "2026-06-01", qualifier: "exact", replacement: "gemini-3.5-flash" },
    { id: "gpt-4o-mini-2024-07-18", provider: "openai", retires: "2026-12-11", qualifier: "exact", replacement: "gpt-5-mini", replacement_alt: "gpt-5-nano" },
  ] });
  const dir = tempRepo({
    "app.py": 'a = "gpt-4-0613"\nb = "openai/gpt-4-0613"\nc = "gpt-4-0613-custom"\nd = "gemini-2.0-flash"\ne = "gpt-4o-mini-2024-07-18"\n',
    "notes.md": "We moved off `gpt-4-0613`.\n",
    ".driftline/prompts.yml": "prompts:\n  - id: a\n    model: gpt-4-0613\n    prompt: hi\n",
  });
  const today = new Date("2026-11-14T00:00:00Z");
  const plan = planFixes(dir, reg, { today });
  assert.deepEqual(plan.changes.map((c) => [c.line, c.from, c.to]), [[1, "gpt-4-0613", "gpt-4.1"], [2, "openai/gpt-4-0613", "openai/gpt-4.1"]]);
  const why = Object.fromEntries(plan.skipped.map((s) => [`${s.file}:${s.line}`, s.reason]));
  assert.match(why["app.py:4"], /more than a rename/); // Gemini 3 needs request changes
  assert.match(why["app.py:5"], /two replacements \(gpt-5-mini or gpt-5-nano\)/); // the person picks one
  assert.match(why["notes.md:1"], /documentation/);
  assert.equal(applyFixes(dir, plan.changes), 2);
  const after = (await import("node:fs")).readFileSync(join(dir, "app.py"), "utf8");
  assert.equal(after, 'a = "gpt-4.1"\nb = "openai/gpt-4.1"\nc = "gpt-4-0613-custom"\nd = "gemini-2.0-flash"\ne = "gpt-4o-mini-2024-07-18"\n');
  assert.equal((await import("node:fs")).readFileSync(join(dir, "notes.md"), "utf8"), "We moved off `gpt-4-0613`.\n");
});

test("SARIF: one result per flagged reference, with level, location and replacement", async () => {
  const { toSarif } = await import("../src/sarif.js");
  const findings = [
    { id: "gpt-4-0613", file: "src\\app.py", line: 3, doc: false, status: "retired", entry: { id: "gpt-4-0613", provider: "openai", retires: "2026-06-06", replacement: "gpt-4.1" } },
    { id: "o3", file: "README.md", line: 9, doc: true, status: "at-risk", entry: { id: "o3", provider: "openai", retires: "2026-12-11", replacement: "gpt-6.1-sol" } },
    { id: "gpt-5.1", file: "a.py", line: 1, doc: false, status: "active", entry: { id: "gpt-5.1", provider: "openai", retires: "2027-07-13" } },
  ];
  const s = toSarif(findings, { version: "9.9.9" });
  assert.equal(s.version, "2.1.0");
  assert.equal(s.runs[0].tool.driver.name, "Driftline");
  const r = s.runs[0].results;
  assert.equal(r.length, 2); // active models are not results
  assert.deepEqual([r[0].ruleId, r[0].level, r[0].locations[0].physicalLocation.artifactLocation.uri, r[0].locations[0].physicalLocation.region.startLine],
    ["driftline/retired-model", "error", "src/app.py", 3]);
  assert.match(r[0].message.text, /Replacement: gpt-4\.1/);
  assert.equal(r[1].level, "note"); // mentions in docs never block
});

test("migrationFor: platform and provider families where a rename isn't enough", async () => {
  const { migrationFor } = await import("../src/migration.js");
  const at = (e) => migrationFor({ retires: "2027-01-01", ...e })?.change;
  assert.equal(at({ id: "imagegeneration@006", provider: "google", platform: "vertex", replacement: "gemini-2.5-flash-image" }), "api");
  assert.equal(at({ id: "playai-tts", provider: "playai", platform: "groq", replacement: "canopylabs/orpheus-v1-english" }), "params");
  assert.equal(at({ id: "meta-llama/llama-guard-4-12b", provider: "meta", platform: "groq", replacement: "openai/gpt-oss-safeguard-20b" }), "api");
  assert.equal(at({ id: "meta-llama/llama-4-scout-17b-16e-instruct", provider: "meta", platform: "groq", replacement: "openai/gpt-oss-120b" }), "features");
  assert.equal(at({ id: "phi-4-multimodal-instruct", provider: "microsoft", platform: "azure", replacement: "microsoft--phi-4" }), "features");
  assert.equal(at({ id: "codestral-2501", provider: "mistral", platform: "azure", replacement: "mistral-large-4-latest" }), "features");
  assert.equal(at({ id: "codestral-2501", provider: "mistral", platform: "mistral", replacement: "codestral-2508" }), "rename");
  assert.equal(at({ id: "llama-guard-3-8b", provider: "meta", platform: "groq", replacement: "meta-llama/llama-guard-4-12b" }), "rename");
});

// Fix pull request: one branch with the safe renames, pushed only when it changed; the checkout is left as it was.
test("fix PR: branch built from the plan, pushed once, checkout untouched", async () => {
  const { execFileSync } = await import("node:child_process");
  const { buildRegistry } = await import("../src/registry.js");
  const { planFixes } = await import("../src/fix.js");
  const { pushFixBranch, BRANCH, authArgs } = await import("../src/pr.js");
  const reg = buildRegistry({ checked: "2026-11-14", sources: {}, models: [
    { id: "gpt-4-0613", provider: "openai", retires: "2026-06-06", qualifier: "exact", replacement: "gpt-4.1" },
  ] });
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const remote = mkdtempSync(join(tmpdir(), "driftline-remote-"));
  sh(remote, "init", "-q", "--bare");
  const dir = tempRepo({ "src/app.py": 'a = "gpt-4-0613"\n', "other.txt": "local edit\n" });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "add", ".");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  sh(dir, "remote", "add", "origin", remote);
  writeFileSync(join(dir, "other.txt"), "changed by an earlier step\n"); // not part of the fix: must not be committed
  const today = new Date("2026-11-14T00:00:00Z");
  const plan = planFixes(join(dir, "src"), reg, { today });
  const first = pushFixBranch({ repoRoot: dir, root: join(dir, "src"), changes: plan.changes, message: "fix" });
  assert.equal(first.pushed, true);
  assert.equal(sh(remote, "show", `${BRANCH}:src/app.py`), 'a = "gpt-4.1"');
  assert.deepEqual(sh(remote, "show", "--name-only", "--format=", BRANCH).split("\n"), ["src/app.py"]);
  assert.equal(sh(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(dir, "src/app.py"), "utf8"), 'a = "gpt-4-0613"\n');
  assert.equal(readFileSync(join(dir, "other.txt"), "utf8"), "changed by an earlier step\n");
  assert.equal(sh(dir, "worktree", "list").split("\n").length, 1);
  const again = pushFixBranch({ repoRoot: dir, root: join(dir, "src"), changes: plan.changes, message: "fix" });
  assert.equal(again.unchanged, true);
  const a = authArgs("tok", "https://github.com");
  assert.deepEqual([a[1], a[3].startsWith("http.https://github.com/.extraheader=AUTHORIZATION: basic ")], ["http.https://github.com/.extraheader=", true]);
  assert.ok(!a.join(" ").includes("tok"));
});

test("fix PR: opened as draft (or not, where drafts aren't allowed), updated, closed", async () => {
  const { upsertPullRequest, prBody, PR_TITLE } = await import("../src/pr.js");
  const calls = [];
  const fake = (existing, draftOk = true) => async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([opts.method || "GET", url, body]);
    if (!opts.method) return reply(200, existing ? [{ number: 3, html_url: "pr3" }] : []);
    if (opts.method === "POST" && body.draft && !draftOk) return reply(422, { message: "Draft pull requests are not supported" });
    return reply(200, { number: 4, html_url: "pr4" });
  };
  const opened = await upsertPullRequest("b", { token: "t", repo: "acme/app", base: "main", fetchImpl: fake(false, false) });
  assert.equal(opened.opened, true);
  assert.match(calls[0][1], /head=acme%3Adriftline%2Fmodel-updates/);
  assert.deepEqual(calls.slice(1).map((c) => [c[0], c[2].draft, c[2].head, c[2].base, c[2].title]), [["POST", true, "driftline/model-updates", "main", PR_TITLE], ["POST", false, "driftline/model-updates", "main", PR_TITLE]]);
  calls.length = 0;
  assert.equal((await upsertPullRequest("b2", { token: "t", repo: "acme/app", base: "main", fetchImpl: fake(true) })).updated, true);
  assert.deepEqual([calls[1][0], calls[1][1].endsWith("/pulls/3"), calls[1][2].body], ["PATCH", true, "b2"]);
  calls.length = 0;
  assert.equal((await upsertPullRequest("done", { token: "t", repo: "acme/app", base: "main", close: true, fetchImpl: fake(true) })).closed, true);
  assert.equal(calls[1][2].state, "closed");
  assert.ok((await upsertPullRequest("x", { token: "t", repo: "acme/app", base: "main", close: true, fetchImpl: fake(false) })).skipped);
  const err = await upsertPullRequest("b", { token: "t", repo: "acme/app", base: "main", fetchImpl: async () => reply(403, { message: "nope" }) }).catch((e) => e);
  assert.match(err.message, /pull-requests: write/);
  const md = prBody({ changes: [{ file: "a.py", line: 1, from: "gpt-4-0613", to: "gpt-4.1", status: "retired", retires: "2026-06-06" }], skipped: [{ file: "b.py", line: 2, id: "gemini-2.0-flash", reason: "more than a rename" }] });
  assert.match(md, /`gpt-4-0613` → `gpt-4.1`/);
  assert.match(md, /Left for you \(1\)/);
});

test("fix PR: Pro drift results go in as scores with a verdict, never the answers", async () => {
  const { prBody } = await import("../src/pr.js");
  const plan = { changes: [{ file: "a.py", line: 1, from: "gpt-4-0613", to: "gpt-4.1", status: "at-risk", retires: "2026-12-11" }], skipped: [] };
  const row = (id, result, score) => ({ id, from: "gpt-4-0613", to: "gpt-4.1", result, score, note: "", before: "SECRET-BEFORE", after: "SECRET-AFTER" });
  const broken = prBody(plan, { drift: [row("a", "same", 0.97), row("b", "broken", 0.1)], runUrl: "https://github.com/o/r/actions/runs/9" });
  assert.match(broken, /Don't merge yet/);
  assert.match(broken, /1 same, 0 changed, 1 broken/);
  assert.match(broken, /\| a \| `gpt-4-0613` → `gpt-4.1` \| 0\.97 \| ✅ Same/);
  assert.match(broken, /\(https:\/\/github\.com\/o\/r\/actions\/runs\/9\)/);
  assert.ok(!broken.includes("SECRET"));
  assert.match(prBody(plan, { drift: [{ ...row("a", "same", 0.97), checked: true }] }), /Safe to merge as far as your prompts show/);
  // Without checks, "same" only means similar wording: the verdict says so and points to checks.
  const unchecked = prBody(plan, { drift: [row("a", "same", 0.97)] });
  assert.match(unchecked, /Similar answers on every prompt/);
  assert.ok(!unchecked.includes("Safe to merge"));
  assert.match(prBody(plan, { drift: [row("a", "changed", 0.4)] }), /Read before you merge/);
  const free = prBody(plan, { drift: [{ id: "x", from: "—", to: "—", result: "skipped" }] });
  assert.ok(!free.includes("Your prompts on the replacement"));
  assert.match(free, /aidriftline\.com\/#drift/);
});

test("fix PR: lines left for you are grouped per model with the guide, and ticks survive an update", async () => {
  const { prBody, keepTicks } = await import("../src/pr.js");
  const gem = { id: "gemini-2.0-flash", to: "gemini-3.5-flash", status: "retired", retires: "2026-06-01", days: -160, reason: "more than a rename: API change (use generateContent)", guide: "https://ai.google.dev/x" };
  const plan = { changes: [], skipped: [
    { ...gem, file: "a.py", line: 4 }, { ...gem, file: "b.py", line: 9 },
    { id: "gpt-4o-mini-2024-07-18", to: "gpt-5-mini", alt: "gpt-5-nano", status: "at-risk", retires: "2026-12-11", days: 26, file: "c.py", line: 1, reason: "the provider names two replacements" },
    { id: "gpt-4-0613", file: "README.md", line: 3, doc: true, reason: "documentation file (left as written)" },
  ] };
  const md = prBody(plan);
  assert.match(md, /### Left for you \(3\)/);
  assert.match(md, /#### `gemini-2\.0-flash` → `gemini-3\.5-flash` · shutdown date passed \(2026-06-01\)\n\nMore than a rename: API change \(use generateContent\)\. \[Provider's guide\]\(https:\/\/ai\.google\.dev\/x\)\n\n- \[ \] `a\.py:4`\n- \[ \] `b\.py:9`/);
  assert.match(md, /`gpt-5-mini` or `gpt-5-nano` · retires 2026-12-11/);
  assert.match(prBody({ changes: [], skipped: [{ ...gem, file: "a.py", line: 4, change: "Parameter changes", note: "Remove temperature." }] }), /\*\*Parameter changes\.\*\* Remove temperature\. \[Provider's guide\]/);
  assert.match(md, /Also mentioned in documentation, left as written: `README\.md:3`\./);
  assert.ok(!md.includes("- [ ] `README.md:3`"));
  const ticked = md.replace("- [ ] `b.py:9`", "- [x] `b.py:9`");
  const next = keepTicks(prBody(plan), ticked);
  assert.match(next, /- \[x\] `b\.py:9`/);
  assert.match(next, /- \[ \] `a\.py:4`/);
  assert.match(keepTicks(prBody(plan), ticked.replace("shutdown date passed", "retires")), /- \[x\] `b\.py:9`/); // wording changes don't drop ticks
  assert.equal(keepTicks("- [ ] `b.py:9`", "#### other\n- [x] `b.py:9`"), "- [ ] `b.py:9`"); // a tick under another model doesn't carry over
});

test("fix PR: people's commits stop updates; merges and Driftline's own commits don't", async () => {
  const { humanCommits } = await import("../src/pr.js");
  const bot = { author: { login: "github-actions[bot]" }, commit: { author: { email: "41898282+github-actions[bot]@users.noreply.github.com" } }, parents: [{}] };
  const merge = { author: { login: "alice" }, commit: { author: { email: "a@x" } }, parents: [{}, {}] }; // GitHub's "Update branch"
  const own = { author: { login: "alice" }, commit: { author: { email: "a@x" } }, parents: [{}] };
  const call = (list) => humanCommits({ token: "t", repo: "o/r", number: 3, fetchImpl: async () => reply(200, list) });
  assert.deepEqual(await call([bot]), []);
  assert.deepEqual(await call([bot, merge]), []);
  assert.deepEqual(await call([bot, merge, own]), ["alice"]);
});

test("fix PR: a pull request the user closed stays closed until a new rename appears", async () => {
  const { prBody, closedByUser, pairsInBody, CLOSED_BY_DRIFTLINE } = await import("../src/pr.js");
  const ch = (from, to, line = 1) => ({ file: "a.py", line, from, to, status: "at-risk", retires: "2027-01-14" });
  const body = prBody({ changes: [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna"), ch("gpt-4.1-nano", "gpt-5.6-luna", 2)], skipped: [] });
  assert.deepEqual([...pairsInBody(body)], ["gpt-4.1-nano→gpt-5.6-luna", "gpt-4o-mini-2024-07-18→gpt-6-luna"]);
  const closed = { body, merged_at: null, closed_at: "2026-11-20T00:00:00Z" };
  assert.equal(closedByUser(closed, [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna", 9)]), true);   // same rename, moved line: stays closed
  assert.equal(closedByUser(closed, [ch("gpt-4o-mini-2024-07-18", "gpt-6.1-luna")]), false);     // provider changed its advice: new
  assert.equal(closedByUser(closed, [ch("o3", "gpt-6.1-sol")]), false);                           // another model: new
  assert.equal(closedByUser({ ...closed, merged_at: "2026-11-21T00:00:00Z" }, [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna")]), false); // merged, not declined
  assert.equal(closedByUser({ ...closed, body: `${CLOSED_BY_DRIFTLINE}: gone` }, [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna")]), false); // Driftline closed it
  const old = "| `a.py:1` | `gpt-4o-mini-2024-07-18` → `gpt-6-luna` | retires 2027-01-14 |"; // pull request from before the tag existed
  assert.equal(closedByUser({ ...closed, body: old }, [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna")]), true);
  assert.equal(closedByUser({ ...closed, body: "edited by hand" }, [ch("gpt-4o-mini-2024-07-18", "gpt-6-luna")]), false); // unknown: don't guess
});

test("fix PR: a push refused for lack of permission says which permission to add", async () => {
  const { execFileSync } = await import("node:child_process");
  const { buildRegistry } = await import("../src/registry.js");
  const { planFixes } = await import("../src/fix.js");
  const { pushFixBranch } = await import("../src/pr.js");
  const reg = buildRegistry({ checked: "2026-11-14", sources: {}, models: [{ id: "gpt-4-0613", provider: "openai", retires: "2026-06-06", qualifier: "exact", replacement: "gpt-4.1" }] });
  const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const remote = mkdtempSync(join(tmpdir(), "driftline-remote-"));
  sh(remote, "init", "-q", "--bare");
  sh(remote, "config", "receive.denyNonFastForwards", "true");
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'remote: Permission to o/r.git denied to github-actions[bot].' >&2\nexit 1\n", { mode: 0o755 });
  const dir = tempRepo({ "a.py": 'a = "gpt-4-0613"\n' });
  sh(dir, "init", "-q", "-b", "main"); sh(dir, "add", "."); sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"); sh(dir, "remote", "add", "origin", remote);
  const plan = planFixes(dir, reg, { today: new Date("2026-11-14T00:00:00Z") });
  assert.throws(() => pushFixBranch({ repoRoot: dir, root: dir, changes: plan.changes, message: "fix" }), /contents: write/);
});

test("fix PR: in a monorepo the pull request names files from the repository root", async () => {
  const { prBody, fromRepoRoot } = await import("../src/pr.js");
  const plan = { changes: [{ file: "llm.py", line: 2, from: "gpt-4.1-nano", to: "gpt-5.6-luna", status: "retired", retires: "2026-10-23" }], skipped: [{ file: "llm.py", line: 3, id: "x", reason: "more than a rename" }] };
  const md = prBody(fromRepoRoot(plan, "services/api"));
  assert.match(md, /`services\/api\/llm\.py:2`/);
  assert.match(md, /- \[ \] `services\/api\/llm\.py:3`/);
  assert.equal(fromRepoRoot(plan, ""), plan);
  assert.equal(plan.changes[0].file, "llm.py"); // the plan used for the edit keeps its own paths
});

test("drift table: replacement-only rows get their own label, and a caveat shared by rows is shown once", async () => {
  const { driftTable } = await import("../src/report.js");
  const cav = "Beyond the model name: Gemini 3 changes the request.";
  const rows = driftTable([
    { id: "a", from: "gemini-2.5-flash", to: "gemini-3.5-flash-lite", result: "changed", only: true, checked: true, note: `Current model not available to this API key. ${cav}`, caveat: cav },
    { id: "b", from: "gemini-2.5-flash", to: "gemini-3.5-flash-lite", result: "changed", only: true, checked: false, note: `Current model not available to this API key. ${cav}`, caveat: cav },
    { id: "c", from: "gpt-4o-mini", to: "gpt-6-luna", result: "changed", score: 0.66, note: "" },
  ]).join("\n");
  assert.match(rows, /\| a \|.*\| — \| 🔵 New model only · checks passed \| Current model not available to this API key\. \[1\] \|/);
  assert.match(rows, /\| b \|.*\| 🔵 New model only \|/);
  assert.match(rows, /\| c \|.*\| 0\.66 \| 🟡 Changed \|/);
  assert.equal(rows.split(cav).length - 1, 1);
  assert.match(rows, /\n1\. Beyond the model name/);
});
