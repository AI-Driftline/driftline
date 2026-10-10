// Calls each provider with the customer's own API key. Keys never leave their CI runner.

export function providerOf(model) {
  if (/^claude-/.test(model)) return "anthropic";
  if (/^(gemini-|text-embedding-)/.test(model)) return "google";
  return "openai";
}

const KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };

export function keyFor(provider, env = process.env) {
  return env[KEY_ENV[provider]] || (provider === "google" ? env.GOOGLE_API_KEY : undefined);
}

export function missingKeyMessage(provider) {
  return `No API key for ${provider}. Add ${KEY_ENV[provider]} as a repository secret and pass it in "env".`;
}

async function postJson(fetchImpl, url, headers, body) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
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
    if (typeof data.output_text === "string") return data.output_text;
    return (data.output || [])
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === "output_text" || typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }

  if (provider === "anthropic") {
    const data = await postJson(fetchImpl, "https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: 2048, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] });
    return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  }

  const data = await postJson(fetchImpl,
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": key },
    { contents: [{ role: "user", parts: [{ text: prompt }] }], ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) });
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}
