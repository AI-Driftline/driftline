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
Object.assign(LICENSE, { storeId: null, productIds: [] });
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
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense({ valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" } }), account: "acme" })).ok, true);
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense({ valid: false, error: "license_key not found." }), account: "acme" })).ok, false);
  assert.equal((await checkLicense("", {})).ok, false);
  assert.equal((await checkLicense("k:i", { fetchImpl: fakeLicense({ valid: true, license_key: { status: "expired" } }), account: "acme" })).ok, false);
});

// ---------- end to end with mocked providers ----------
function fakeProviders(calls) {
  return async (url, opts) => {
    calls.push(url);
    if (url.includes("lemonsqueezy")) return { ok: true, json: async () => ({ valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" } }) };
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
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
const licensed = (answer) => async (url) => url.includes("lemonsqueezy")
  ? { status: 200, json: async () => ({ valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" } }) }
  : { ok: true, status: 200, text: async () => JSON.stringify(url.includes("anthropic") ? { content: [{ type: "text", text: answer }] } : { output_text: answer }) };

test("cloud-platform spellings map to provider IDs", () => {
  assert.equal(normalizeId("anthropic.claude-3-5-sonnet-20240620-v1:0"), "claude-3-5-sonnet-20240620");
  assert.equal(normalizeId("us.anthropic.claude-3-5-sonnet-20240620-v2:0"), "claude-3-5-sonnet-20240620");
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

// Real license codes are "<key uuid>:<instance uuid>".
const REAL_CODE = "38b1460a-5104-4067-a91d-77b872934d51:f90ec370-fd83-46a5-8bbd-44a241e78665";

test("license: a Lemon Squeezy outage does not lock out paying users", async () => {
  const r = await checkLicense(REAL_CODE, { fetchImpl: async () => ({ status: 503, json: async () => { throw new Error("html"); } }), account: "acme" });
  assert.equal(r.ok, true);
  const offline = await checkLicense(REAL_CODE.toUpperCase(), { fetchImpl: async () => { throw new TypeError("fetch failed"); }, account: "acme" });
  assert.equal(offline.ok, true);
});

test("license: without a known GitHub account, a valid code does not unlock Pro", async () => {
  const fetchImpl = async () => reply(200, { valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" }, meta: {} });
  for (const account of [undefined, "", "  ", "globex"]) {
    assert.equal((await checkLicense(REAL_CODE, { fetchImpl, account })).ok, false, `account ${JSON.stringify(account)}`);
  }
  assert.equal((await checkLicense(REAL_CODE, { fetchImpl, account: " ACME " })).ok, true);
  const offline = async () => { throw new TypeError("fetch failed"); };
  assert.equal((await checkLicense(REAL_CODE, { fetchImpl: offline })).ok, false, "no outage pass without an account either");
});

test("license: blocking Lemon Squeezy with a made-up code unlocks nothing", async () => {
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
  const fetchImpl = async (url, opts) => { if (!url.includes("lemonsqueezy")) calls++; return licensed("hi")(url, opts); };
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

test("license: new (inactive) keys work; expired and disabled don't; odd replies don't crash", async () => {
  const lic = (body, status = 200) => checkLicense("k:i", { fetchImpl: async () => reply(status, body), account: "acme" });
  assert.equal((await lic({ valid: true, license_key: { status: "inactive" }, instance: { id: "i", name: "github:acme" } })).ok, true);
  assert.equal((await lic({ valid: true, license_key: { status: "expired" } })).ok, false);
  assert.equal((await lic({ valid: true, license_key: { status: "disabled" } })).ok, false);
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
  assert.equal(normalizeId("arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0"), "claude-3-5-sonnet-20241022");
});

test("a current model's empty answer keeps the replacement's answer", async () => {
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  const fetchImpl = async (url, opts) => {
    if (url.includes("lemonsqueezy")) return reply(200, { valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" } });
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
  assert.equal(normalizeId("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0"), "claude-3-5-sonnet-20240620");
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
  const ok = await activate(" KEY-1 ", "Acme", { fetchImpl: async (url, opts) => {
    sent.push([url, String(opts.body)]);
    return reply(200, { activated: true, instance: { id: "inst-9", name: "github:acme" }, license_key: { activation_usage: 1, activation_limit: 3 }, meta: {} });
  } });
  assert.deepEqual([ok.ok, ok.code, ok.used, ok.limit], [true, "KEY-1:inst-9", 1, 3]);
  assert.match(sent[0][0], /\/activate$/);
  assert.match(sent[0][1], /instance_name=github%3Aacme/);
  const full = await activate("KEY-1", "acme", { fetchImpl: async () => reply(400, { activated: false, error: "This license key has reached the activation limit." }) });
  assert.equal(full.ok, false);
  assert.match(full.reason, /3 GitHub accounts.*deactivate/);
  assert.equal((await activate("KEY-1", "", {})).ok, false); // account unknown: ask for --account
});

test("license code: must be activated, and for the account the workflow runs in", async () => {
  assert.deepEqual(parseCode("a-b-c:inst-1"), { key: "a-b-c", instanceId: "inst-1" });
  assert.equal(instanceName(" Acme "), "github:acme");
  const valid = (name) => async (url, opts) => {
    assert.match(String(opts.body), /instance_id=inst-1/);
    return reply(200, { valid: true, license_key: { status: "active" }, instance: name ? { id: "inst-1", name } : null, meta: {} });
  };
  assert.match((await checkLicense("plain-key", { fetchImpl: valid("github:acme"), account: "acme" })).reason, /not activated yet/);
  assert.equal((await checkLicense("k:inst-1", { fetchImpl: valid("github:acme"), account: "Acme" })).ok, true);
  const other = await checkLicense("k:inst-1", { fetchImpl: valid("github:acme"), account: "globex" });
  assert.equal(other.ok, false);
  assert.match(other.reason, /activated for "acme", not "globex"/);
  assert.match((await checkLicense("k:inst-1", { fetchImpl: valid(null), account: "acme" })).reason, /activation was removed/);
});

test("deactivate frees a slot", async () => {
  assert.equal((await deactivate("k:inst-1", { fetchImpl: async () => reply(200, { deactivated: true }) })).ok, true);
  assert.equal((await deactivate("k", {})).ok, false); // a bare key is not a license code
});

test("run: a code copied to another company runs the scan but not the drift tests", async () => {
  const dir = tempRepo({ "a.py": 'm = "gpt-4"\n', ".driftline/prompts.yml": "prompts:\n  - id: a\n    prompt: hi\n" });
  let aiCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("lemonsqueezy")) return reply(200, { valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" } });
    aiCalls++; return reply(200, { output_text: "hi" });
  };
  const r = await run({ root: dir, today: TODAY, registry, licenseKey: "k:i", account: "globex", fetchImpl, env: { OPENAI_API_KEY: "x" } });
  assert.equal(r.findings.length, 1);
  assert.equal(aiCalls, 0);
  assert.ok(r.notices.some((n) => n.includes('activated for "acme"')));
});

test("only keys from Driftline's store and product unlock Pro", async () => {
  Object.assign(LICENSE, REAL_LICENSE);
  try {
    const key = (meta) => checkLicense("k:i", { account: "acme", fetchImpl: async () =>
      reply(200, { valid: true, license_key: { status: "active" }, instance: { id: "i", name: "github:acme" }, meta }) });
    assert.equal((await key({ store_id: 494524, product_id: 1432580 })).ok, true);
    assert.equal((await key({ store_id: "494524", product_id: "1432580" })).ok, true);    // strings from the API are fine
    assert.match((await key({ store_id: 999, product_id: 1432580 })).reason, /different product/);   // someone else's store
    assert.match((await key({ store_id: 494524, product_id: 555 })).reason, /different product/);    // another product of ours
    assert.match((await key({ store_id: 494524, product_id: 1428709 })).reason, /different product/);  // test-mode product
    assert.match((await key({})).reason, /different product/);
  } finally {
    Object.assign(LICENSE, { storeId: null, productIds: [] });
  }
});
