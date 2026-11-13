// MCP server (stdio): lets coding agents ask Driftline about model retirements.
//   npx -y github:AI-Driftline/driftline mcp
// Speaks JSON-RPC 2.0, one message per line on stdin/stdout (the MCP stdio transport). No dependencies.
// Data: the live registry at aidriftline.com/models.json (updated daily), or the copy bundled with this
// version when the site can't be reached or is older. Set DRIFTLINE_OFFLINE=1 to never fetch.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadBestRegistry, classify, normalizeId, replacementChange } from "./registry.js";
import { scanDirectory } from "./scan.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const page = (id) => `https://aidriftline.com/models/${id}/`;
const WHO = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };

export { loadBestRegistry }; // shared with the Action and CLI (src/registry.js)

// One plain sentence an agent can pass on to the user.
function advice(c, today = new Date()) {
  const m = c.entry;
  if (!m) return "Not in Driftline's registry: no retirement is announced for it on the OpenAI, Anthropic or Google deprecation pages (or it is not a model ID).";
  const who = WHO[m.provider] || m.provider;
  const chg = replacementChange(m, today);
  const repl = m.replacement ? ` Replacement: ${m.replacement}${m.replacement_note ? ` (${m.replacement_note})` : ""}.${chg ? ` ${who} changed this recommendation on ${chg.on}; before it was ${chg.was}.` : ""}` : "";
  if (m.qualifier === "not-before") return `Active. ${who} says it will not be retired before ${m.retires}.`;
  if (m.routes) return c.days <= 0
    ? `Since ${m.retires}, ${who} answers requests for it with ${m.replacement}. No error, but answers come from a different model.`
    : `From ${m.retires} (in ${c.days} days), ${who} will answer requests for it with ${m.replacement}.`;
  if (m.qualifier === "earliest") return c.days <= 0
    ? `${who} listed ${m.retires} as the earliest shutdown date; it can stop working at any time now.${repl}`
    : `${who} may shut it down from ${m.retires} (in ${c.days} days).${repl}`;
  return c.days <= 0 ? `Retired on ${m.retires}. Calls to it fail.${repl}` : `Retires on ${m.retires} (in ${c.days} days). Calls fail after that.${repl}`;
}

function describe(rawId, reg, today) {
  const id = normalizeId(rawId);
  const c = classify(id, reg, { today });
  const m = c.entry;
  return {
    id: rawId, ...(id !== rawId ? { normalized: id } : {}),
    status: c.status, ...(m ? {
      provider: m.provider, retires: m.retires, qualifier: m.qualifier, days_left: c.days,
      replacement: m.replacement || null, ...(m.replacement_note ? { replacement_note: m.replacement_note } : {}),
      ...(m.previous_replacement ? { previous_replacement: m.previous_replacement, replacement_changed: m.replacement_changed } : {}), routes: !!m.routes, ...(m.aliasOf ? { alias_of: m.aliasOf } : {}), page: page(m.aliasOf || m.id),
    } : {}),
    advice: advice(c, today),
  };
}

const STATUS_ENUM = ["retired", "at-risk", "deprecated", "active", "unknown"];
const MODEL_RESULT = {
  type: "object",
  properties: {
    id: { type: "string", description: "The ID as given" },
    normalized: { type: "string", description: "The ID after removing provider prefixes such as models/ or openai/" },
    status: { type: "string", enum: STATUS_ENUM, description: "retired = calls fail (or are re-routed) now; at-risk = retires within 90 days; deprecated = retirement announced, further out; active = announced as active; unknown = no retirement published" },
    provider: { type: "string" }, retires: { type: "string", description: "YYYY-MM-DD" },
    qualifier: { type: "string", enum: ["exact", "earliest", "not-before"], description: "exact date, earliest possible shutdown (Google), or not before this date (Anthropic)" },
    days_left: { type: "number", description: "Days until the date; 0 or negative when it has passed" },
    replacement: { type: ["string", "null"] },
    previous_replacement: { type: "string", description: "The replacement the provider recommended before it changed its advice" },
    replacement_changed: { type: "string", description: "YYYY-MM-DD: when the change was seen on the provider's page" },
    replacement_note: { type: "string", description: "Extra instruction the provider gives with the replacement (e.g. a setting or API to use). Without it, switching the model name alone is not enough" },
    routes: { type: "boolean", description: "true: after the date the provider answers with the replacement model instead of failing" },
    alias_of: { type: "string" }, page: { type: "string", description: "aidriftline.com page with the source for this date" },
    advice: { type: "string", description: "One plain sentence to pass on to the user" },
  },
  required: ["id", "status", "advice"],
};
const META = {
  registry_checked: { type: "string", description: "Date the registry was last checked against the provider pages" },
  registry_source: { type: "string", enum: ["live", "bundled"], description: "live = aidriftline.com/models.json; bundled = the copy shipped in the package (used offline)" },
  all_dates: { type: "string" },
  next_step: { type: "string", description: "Present when a model has to move: how to test prompts on the replacement first" },
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "check_models",
    title: "Check model IDs for retirement",
    description: "Look up OpenAI, Anthropic and Google model IDs and return, for each one, its retirement status, retirement date, days left and replacement. " +
      "Use it before writing, changing or keeping a model ID in code, or when the user asks whether a model still works. " +
      "To find the IDs inside a codebase use scan_project instead; to list everything retiring soon use upcoming_retirements. " +
      "Read-only. Data comes from the providers' official deprecation pages, re-checked daily at aidriftline.com (fetched with a 4 s timeout, falling back to the copy in the package when offline). " +
      "IDs not in the registry return status \"unknown\": no retirement is published for them, which does not prove the ID exists. Up to 100 IDs per call; extra IDs are ignored.",
    inputSchema: { type: "object", properties: {
      ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100,
        description: "Model IDs exactly as written in code, e.g. [\"gpt-4o\", \"claude-sonnet-4-5\", \"models/gemini-2.5-pro\"]. Provider prefixes (openai/, models/), Bedrock, Vertex and OpenRouter spellings and Claude short names are accepted and normalized." },
    }, required: ["ids"] },
    outputSchema: { type: "object", properties: { models: { type: "array", items: MODEL_RESULT }, ...META }, required: ["models", "registry_checked", "registry_source"] },
    annotations: { title: "Check model IDs for retirement", ...READ_ONLY },
  },
  {
    name: "scan_project",
    title: "Scan a project for retiring model IDs",
    description: "Scan a project folder for OpenAI, Anthropic and Google model IDs in code and config files and report the ones that are retired, retiring soon, deprecated or being re-routed, with file and line, most urgent first. " +
      "Use it to audit a repository or before a release. For IDs you already know use check_models; for a time-based list use upcoming_retirements. " +
      "Read-only: reads files on this machine and never changes them. Scans subfolders recursively, skips .git, node_modules, vendor, dist, build and similar folders, and files over 1 MB. " +
      "Mentions in .md and .txt files are marked in_docs. Returns at most 200 findings (truncated: true when cut). Fails with an error if the path does not exist.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Absolute path of the folder to scan. Defaults to the server's working directory, which may not be the user's project, so pass it explicitly." },
      include_ok: { type: "boolean", default: false, description: "Also list models with no retirement announced (status active or unknown). Default false." },
    } },
    outputSchema: { type: "object", properties: {
      scanned: { type: "string" }, model_references: { type: "number", description: "All model ID mentions found, before filtering" },
      flagged: { type: "number" }, truncated: { type: "boolean" },
      findings: { type: "array", items: { ...MODEL_RESULT, properties: { file: { type: "string" }, line: { type: "number" }, in_docs: { type: "boolean" }, ...MODEL_RESULT.properties } } },
      ...META,
    }, required: ["scanned", "flagged", "findings"] },
    annotations: { title: "Scan a project for retiring model IDs", ...READ_ONLY },
  },
  {
    name: "upcoming_retirements",
    title: "List upcoming model retirements",
    description: "List OpenAI, Anthropic and Google models whose retirement or re-routing date falls in the next N days, soonest first, with replacement for each. " +
      "Use it to answer \"what is being retired soon?\" or to plan migrations. It does not look at code: use scan_project for that, or check_models for specific IDs. " +
      "Read-only. Models already past their date are not included (check_models reports those as retired). Anthropic \"not before\" dates are left out because those models are still active.",
    inputSchema: { type: "object", properties: {
      days: { type: "number", minimum: 1, maximum: 3650, default: 90, description: "Look-ahead window in days, 1 to 3650. Default 90." },
      provider: { type: "string", enum: ["openai", "anthropic", "google"], description: "Only this provider. Omit for all three." },
    } },
    outputSchema: { type: "object", properties: { days: { type: "number" }, count: { type: "number" }, models: { type: "array", items: MODEL_RESULT }, ...META }, required: ["days", "count", "models"] },
    annotations: { title: "List upcoming model retirements", ...READ_ONLY },
  },
];

// When a model has to move, the open question is whether the replacement answers the same way.
const SWITCHING = new Set(["retired", "at-risk", "deprecated"]);
function nextStep(rows) {
  const r = rows.find((x) => x.replacement && (SWITCHING.has(x.status) || x.routes));
  if (!r) return {};
  return { next_step: `Before moving ${r.id} to ${r.replacement}, test the prompts this app really sends on both models: answers often change between model versions. ` +
    "Driftline Pro runs each prompt on the current model and the replacement in GitHub Actions and shows what changed (https://aidriftline.com/#drift)." };
}

export async function callTool(name, args = {}, { reg, source, today = new Date() }) {
  const meta = { registry_checked: reg.checked, registry_source: source, all_dates: "https://aidriftline.com/models/" };
  if (name === "check_models") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === "string").slice(0, 100) : [];
    if (!ids.length) throw new Error("ids must be a non-empty array of model ID strings");
    const models = ids.map((id) => describe(id, reg, today));
    return { models, ...nextStep(models), ...meta };
  }
  if (name === "scan_project") {
    const root = resolve(args.path || ".");
    let isDir = false;
    try { isDir = statSync(root).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw new Error(`Not a folder: ${root}. Pass the absolute path of the project to scan.`);
    const hits = scanDirectory(root, { known: reg.byId });
    const rows = hits.map((h) => ({ file: h.file.split("\\").join("/"), line: h.line, in_docs: h.doc, ...describe(h.id, reg, today) }))
      .filter((r) => args.include_ok || !["active", "unknown"].includes(r.status));
    const order = { retired: 0, "at-risk": 1, deprecated: 2, active: 3, unknown: 4 };
    rows.sort((a, b) => order[a.status] - order[b.status] || (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
    return { scanned: root, model_references: hits.length, flagged: rows.length, findings: rows.slice(0, 200),
      ...(rows.length > 200 ? { truncated: true } : {}), ...nextStep(rows), ...meta };
  }
  if (name === "upcoming_retirements") {
    const days = Number.isFinite(args.days) && args.days > 0 ? Math.min(args.days, 3650) : 90;
    const list = reg.models
      .filter((m) => m.qualifier !== "not-before" && (!args.provider || m.provider === args.provider))
      .map((m) => describe(m.id, reg, today))
      .filter((r) => r.days_left > 0 && r.days_left <= days)
      .sort((a, b) => a.days_left - b.days_left || a.id.localeCompare(b.id));
    return { days, count: list.length, models: list, ...meta };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function startServer({ input = process.stdin, output = process.stdout, load = loadBestRegistry } = {}) {
  let registry = null;
  const getRegistry = () => (registry ||= load());
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  async function handle(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        getRegistry(); // start the download early
        return { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "driftline", version: VERSION },
          instructions: "Driftline knows when OpenAI, Anthropic and Google retire their models (from their official deprecation pages, checked daily). Call check_models before adding or keeping a model ID in code, and scan_project to audit a codebase." };
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "tools/call": {
        try {
          const result = await callTool(params?.name, params?.arguments || {}, await getRegistry());
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
        } catch (e) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
      }
      default:
        if (id === undefined) return undefined; // notifications need no answer
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  const rl = createInterface({ input });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    if (msg.id === undefined) { handle(msg).catch(() => {}); return; }
    try { send({ id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
  });
  return rl;
}
