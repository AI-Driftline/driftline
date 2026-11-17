// Pro features (drift tests) need a Driftline Pro license key (sold through Polar), activated once per GitHub account.
// API: https://api.polar.sh/v1/customer-portal/license-keys/{activate,validate,deactivate} (JSON, no token: these
// endpoints are meant for public clients, so the Action needs no secret of ours).
//
// A key works on up to 3 GitHub accounts or organizations (the activation limit set on the Polar benefit).
// `driftline activate <key>` registers one account and prints a license code: "<key>:<activation id>".
// The Action checks that code on every run and that it was activated for the account it runs in.

// Only keys from Driftline's own Polar organization and Pro benefit unlock Pro. A key for another
// organization or another benefit is rejected. (benefitId null = no benefit check; tests use that.)
export const LICENSE = { organizationId: "dc2cfa68-903e-4bea-8982-36c017a1ab70", benefitId: "797fc8ef-427d-4d95-beff-cb01277ce1a5" };

const API = "https://api.polar.sh/v1/customer-portal/license-keys";
const ACTIVATE_HELP = "Run `npx @aidriftline/driftline activate <your-license-key>` once for this GitHub account and save the code it prints as DRIFTLINE_LICENSE_KEY.";
const NOT_ACTIVE = "This license key is not active: the subscription ended or was refunded, or it is not a Driftline Pro key. The scan still runs; drift tests are off. Renew at https://aidriftline.com.";

export const instanceName = (account) => `github:${String(account).trim().toLowerCase()}`;

export function parseCode(code) {
  const s = String(code || "").trim();
  const i = s.lastIndexOf(":");
  return i > 0 ? { key: s.slice(0, i), instanceId: s.slice(i + 1) } : { key: s, instanceId: "" };
}

// Polar keys are the benefit prefix plus a UUID (DRIFTLINE-<uuid>); activation ids are UUIDs.
const HEX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^DRIFTLINE[-_]${HEX}$`, "i");
const UUID = new RegExp(`^${HEX}$`, "i");
const looksReal = (key, instanceId) => KEY.test(key) && UUID.test(instanceId);

async function call(fetchImpl, action, fields) {
  return fetchImpl(`${API}/${action}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ organization_id: LICENSE.organizationId, ...fields }),
    signal: AbortSignal.timeout(15_000),
  });
}
const readJson = async (res) => { try { return await res.json(); } catch { return null; } };
const benefitOk = (data) => !LICENSE.benefitId || data?.benefit_id === LICENSE.benefitId;
const withBenefit = () => (LICENSE.benefitId ? { benefit_id: LICENSE.benefitId } : {});

/**
 * Checks a license code on each run. `account` is the GitHub owner the code runs in
 * (GITHUB_REPOSITORY_OWNER in CI, else the origin remote); Pro needs it, or one key would work everywhere.
 */
export async function checkLicense(code, { fetchImpl = fetch, account = "" } = {}) {
  if (!code) return { ok: false, reason: "No license key. The scan ran; drift tests need Driftline Pro." };
  const { key, instanceId } = parseCode(code);
  if (!instanceId) return { ok: false, reason: `This license key is not activated yet. ${ACTIVATE_HELP}` };
  if (!String(account).trim()) return { ok: false, reason: "Could not tell which GitHub account this runs in, so drift tests were skipped. Run inside a repository whose origin is on GitHub." };

  // Do not punish paying users for a network blip: allow the run and say so. Only for codes shaped
  // like a real one, so blocking api.polar.sh with a made-up code like "a:b" unlocks nothing.
  const outage = (why) => looksReal(key, instanceId)
    ? { ok: true, reason: `License server ${why}; drift tests ran anyway.` }
    : { ok: false, reason: `License server ${why}, and this is not a Driftline license code. ${ACTIVATE_HELP}` };
  let res;
  try {
    res = await call(fetchImpl, "validate", { key, activation_id: instanceId, ...withBenefit() });
  } catch (e) {
    return outage(`unreachable (${e.message})`);
  }
  if (res.status === 429 || res.status >= 500) return outage(`unavailable (HTTP ${res.status})`);
  const data = await readJson(res);
  if (res.status === 404) {
    // The key with this activation isn't valid. Ask about the key alone: still granted means the
    // activation was removed (deactivated, or belongs to another key); otherwise the key itself has ended.
    const keyAlone = await call(fetchImpl, "validate", { key, ...withBenefit() }).then(readJson, () => null);
    if (keyAlone?.status === "granted") return { ok: false, reason: `This activation was removed. ${ACTIVATE_HELP}` };
    return { ok: false, reason: NOT_ACTIVE };
  }
  if (res.status !== 200 || !data || typeof data !== "object") return { ok: false, reason: `License key could not be checked (HTTP ${res.status}).` };
  if (data.status !== "granted") return { ok: false, reason: NOT_ACTIVE };
  if (!benefitOk(data)) return { ok: false, reason: "License key belongs to a different product." };
  if (!data.activation) return { ok: false, reason: `This activation was removed. ${ACTIVATE_HELP}` };
  if (data.activation.label !== instanceName(account)) {
    const where = String(data.activation.label || "").replace(/^github:/, "");
    return { ok: false, reason: `This license code was activated for "${where}", not "${account}". A key works on up to 3 GitHub accounts or organizations. ${ACTIVATE_HELP}` };
  }
  return { ok: true };
}

/** Registers one GitHub account. Returns { ok, code, limit } or { ok: false, reason }. */
export async function activate(key, account, { fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, reason: "Give your license key: driftline activate <license-key>" };
  if (!account) return { ok: false, reason: "Could not tell which GitHub account this is for. Add --account <name>." };
  key = String(key).trim();
  let res, data;
  try {
    res = await call(fetchImpl, "activate", { key, label: instanceName(account) });
    data = await readJson(res);
  } catch (e) {
    return { ok: false, reason: `Could not reach the license server (Polar): ${e.message}` };
  }
  const detail = String(data?.detail && typeof data.detail === "string" ? data.detail : "").replace(/\.+$/, "");
  if (res.status === 404) return { ok: false, reason: "No such license key. Copy the whole key from your Polar receipt email or the Polar customer portal (it starts with DRIFTLINE)." };
  if (res.status === 403) {
    if (/limit/i.test(detail)) return { ok: false, reason: "This key is already used on 3 GitHub accounts. Free one in the Polar customer portal (link in your receipt email) or with `npx @aidriftline/driftline deactivate <code>`, or write to hello@aidriftline.com." };
    if (/revoked|disabled|expired/i.test(detail)) return { ok: false, reason: NOT_ACTIVE };
    return { ok: false, reason: `Not activated: ${detail || "not permitted"}.` };
  }
  if (res.status !== 200 || !data?.id) return { ok: false, reason: `Not activated: ${detail || `HTTP ${res.status}`}.` };
  if (!benefitOk(data.license_key)) return { ok: false, reason: "This key belongs to a different product." };
  return { ok: true, code: `${key}:${data.id}`, limit: data.license_key?.limit_activations };
}

/** Frees the slot used by a license code. */
export async function deactivate(code, { fetchImpl = fetch } = {}) {
  const { key, instanceId } = parseCode(code);
  if (!instanceId) return { ok: false, reason: "Give the license code that `driftline activate` printed (it contains a colon)." };
  let res;
  try {
    res = await call(fetchImpl, "deactivate", { key, activation_id: instanceId });
  } catch (e) {
    return { ok: false, reason: `Could not reach the license server (Polar): ${e.message}` };
  }
  if (res.status === 204 || res.status === 200) return { ok: true };
  if (res.status === 404) return { ok: false, reason: "Not deactivated: no such activation for this key (it may already be free)." };
  const data = await readJson(res);
  return { ok: false, reason: `Not deactivated: ${typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`}` };
}
