// MCP server (stdio): lets coding agents ask Driftline about model retirements.
//   npx -y github:AI-Driftline/driftline mcp
// Speaks JSON-RPC 2.0, one message per line on stdin/stdout (the MCP stdio transport). No dependencies.
// Data: the live registry at aidriftline.com/models.json (updated daily), or the copy bundled with this
// version when the site can't be reached or is older. Set DRIFTLINE_OFFLINE=1 to never fetch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { REGISTRY_PATH, buildRegistry, classify, normalizeId } from "./registry.js";
import { scanDirectory } from "./scan.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const LIVE_URL = "https://aidriftline.com/models.json";
const page = (id) => `https://aidriftline.com/models/${id}/`;
const WHO = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };

export async function loadBestRegistry({ fetchImpl = fetch, offline = process.env.DRIFTLINE_OFFLINE === "1" } = {}) {
  const bundled = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  if (offline) return { reg: buildRegistry(bundled), source: "bundled" };
  try {
    const res = await fetchImpl(LIVE_URL, { signal: AbortSignal.timeout(4000) });
    const live = res.ok ? await res.json() : null;
    if (live?.models?.length && live.checked >= bundled.checked) return { reg: buildRegistry(live), source: "live" };
  } catch { /* offline or slow: use the bundled copy */ }
  return { reg: buildRegistry(bundled), source: "bundled" };
}

// One plain sentence an agent can pass on to the user.
function advice(c) {
  const m = c.entry;
  if (!m) return "Not in Driftline's registry: no retirement is announced for it on the OpenAI, Anthropic or Google deprecation pages (or it is not a model ID).";
  const who = WHO[m.provider] || m.provider;
  const repl = m.replacement ? ` Replacement: ${m.replacement}.` : "";
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
      replacement: m.replacement || null, routes: !!m.routes, ...(m.aliasOf ? { alias_of: m.aliasOf } : {}), page: page(m.aliasOf || m.id),
    } : {}),
    advice: advice(c),
  };
}

const TOOLS = [
  {
    name: "check_models",
    description: "Check AI model IDs (OpenAI, Anthropic, Google) for retirement: status, retirement date, replacement. Use before writing or keeping a model ID in code. Accepts provider spellings such as models/gemini-2.5-pro, openai/gpt-4o or Bedrock IDs.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Model IDs, e.g. [\"gpt-4o\", \"claude-sonnet-4-5\"]" } }, required: ["ids"] },
  },
  {
    name: "scan_project",
    description: "Scan a project folder for AI model IDs in code and config and report the ones that are retired, retiring or being re-routed, with file and line. Pass the absolute path of the project if unsure what the current directory is.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Folder to scan (default: the server's current directory)" },
      include_ok: { type: "boolean", description: "Also list models with no retirement announced (default false)" },
    } },
  },
  {
    name: "upcoming_retirements",
    description: "List AI models retiring or being re-routed in the next N days, soonest first. Optionally filter by provider.",
    inputSchema: { type: "object", properties: {
      days: { type: "number", description: "Look-ahead window in days (default 90)" },
      provider: { type: "string", enum: ["openai", "anthropic", "google"] },
    } },
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
