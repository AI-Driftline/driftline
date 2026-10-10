// Calls each provider with the customer's own API key. Keys never leave their CI runner.

export function providerOf(model) {
  if (/^claude-/.test(model)) return "anthropic";
  if (/^(gemini-|text-embedding-0)/.test(model)) return "google"; // OpenAI's are text-embedding-3-* / -ada-*
  return "openai";
}

const KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };

export function keyFor(provider, env = process.env) {
  return env[KEY_ENV[provider]] || (provider === "google" ? env.GOOGLE_API_KEY : undefined);
}

export function missingKeyMessage(provider) {
  return `No API key for ${provider}. Add ${KEY_ENV[provider]} as a repository secret and pass it in "env".`;
}

const TIMEOUT_MS = 120_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]); // busy or overloaded: worth one more try
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const retry = { delayMs: 5000 }; // tests set this to 0

async function postJson(fetchImpl, url, headers, body) {
  try {
    return await postOnce(fetchImpl, url, headers, body);
  } catch (e) {
    if (!RETRY_STATUS.has(e.status)) throw e;
    await wait(Math.min(e.retryAfterMs ?? retry.delayMs, retry.delayMs ? 30_000 : 0));
    return postOnce(fetchImpl, url, headers, body);
  }
}

// An empty answer is not a "changed" answer: say why the model gave nothing.
function nothing(reason) {
  throw new Error(`Empty answer${reason ? ` (${reason})` : ""}`);
}

async function postOnce(fetchImpl, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS), // a hung request must not hold the job for hours
    });
  } catch (e) {
    if (e.name === "TimeoutError") throw new Error(`No answer after ${TIMEOUT_MS / 1000} seconds`);
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    const err = new Error(`HTTP ${res.status}: ${String(msg).replace(/\s+/g, " ").slice(0, 300)}`);
    err.status = res.status;
    const ra = Number(res.headers?.get?.("retry-after"));
    if (ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }
  return json;
}

export async function complete({ model, prompt, system, env = process.env, fetchImpl = fetch }) {
  const provider = providerOf(model);
  const key = keyFor(provider, env);
  if (!key) throw new Error(missingKeyMessage(provider));

  if (provider === "openai") {
    const data = await postJson(fetchImpl, "https://api.openai.com/v1/responses",
      { authorization: `Bearer ${key}` },
      { model, input: prompt, ...(system ? { instructions: system } : {}) });
    const text = typeof data.output_text === "string" ? data.output_text : (data.output || [])
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text" || typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    const refusal = (data.output || []).flatMap((o) => o.content || []).find((c) => c.type === "refusal");
    return text.trim() ? text : nothing(refusal ? "refused" : data.incomplete_details?.reason || data.status);
  }

  if (provider === "anthropic") {
    const data = await postJson(fetchImpl, "https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: 4096, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] });
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    if (data.stop_reason === "max_tokens") throw new Error("Answer cut off at 4,096 tokens; shorten the prompt or ask for less");
    return text.trim() ? text : nothing(data.stop_reason);
  }

  const data = await postJson(fetchImpl,
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": key },
    { contents: [{ role: "user", parts: [{ text: prompt }] }], ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) });
  const c = data.candidates?.[0];
  const text = (c?.content?.parts || []).map((p) => p.text || "").join("");
  return text.trim() ? text : nothing(c?.finishReason || data.promptFeedback?.blockReason);
}
