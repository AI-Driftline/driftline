// Pro features (drift tests) need a Lemon Squeezy license, activated once per GitHub account.
// API: https://api.lemonsqueezy.com/v1/licenses/{activate,validate,deactivate} (form fields)
//
// A key works on up to 3 GitHub accounts or organizations (the activation limit set in Lemon Squeezy).
// `driftline activate <key>` registers one account and prints a license code: "<key>:<instance id>".
// The Action checks that code on every run and that it was activated for the account it runs in.

// Only keys from Driftline's own store and product unlock Pro. A key bought in another store,
// or for another product in this store, is rejected. (null / [] = no check; tests use that.)
// Test mode product: 1428709. Add the live product ID after "Copy to Live Mode".
export const LICENSE = { storeId: 494524, productIds: [1428709] };

const API = "https://api.lemonsqueezy.com/v1/licenses";
const ACTIVATE_HELP = "Run `npx github:AI-Driftline/driftline activate <your-license-key>` once for this GitHub account and save the code it prints as DRIFTLINE_LICENSE_KEY.";

export const instanceName = (account) => `github:${String(account).trim().toLowerCase()}`;

export function parseCode(code) {
  const s = String(code || "").trim();
  const i = s.lastIndexOf(":");
  return i > 0 ? { key: s.slice(0, i), instanceId: s.slice(i + 1) } : { key: s, instanceId: "" };
}

async function call(fetchImpl, action, fields) {
  return fetchImpl(`${API}/${action}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15_000),
  });
}

const productOk = (data) =>
  (LICENSE.storeId == null || Number(data.meta?.store_id) === Number(LICENSE.storeId)) &&
  (!LICENSE.productIds.length || LICENSE.productIds.map(Number).includes(Number(data.meta?.product_id)));

/**
 * Checks a license code on each run. `account` is the GitHub owner the workflow runs in
 * (GITHUB_REPOSITORY_OWNER); without it (local CLI use) only the code itself is checked.
 */
export async function checkLicense(code, { fetchImpl = fetch, account = "" } = {}) {
  if (!code) return { ok: false, reason: "No license key. The scan ran; drift tests need Driftline Pro." };
  const { key, instanceId } = parseCode(code);
  if (!instanceId) return { ok: false, reason: `This license key is not activated yet. ${ACTIVATE_HELP}` };

  let res;
  try {
    res = await call(fetchImpl, "validate", { license_key: key, instance_id: instanceId });
  } catch (e) {
    // Do not punish paying users for a network blip: allow the run and say so.
    return { ok: true, reason: `License server unreachable (${e.message}); drift tests ran anyway.` };
  }
  if (res.status === 429 || res.status >= 500) {
    return { ok: true, reason: `License server unavailable (HTTP ${res.status}); drift tests ran anyway.` };
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!data || typeof data !== "object") return { ok: false, reason: `License key could not be checked (HTTP ${res.status}).` };
  if (!data.valid) {
    const why = data.error ? `: ${String(data.error).replace(/\.+$/, "")}` : "";
    return { ok: false, reason: `License not valid${why}. ${ACTIVATE_HELP}` };
  }
  // "expired": the subscription ended. "disabled": refunded or blocked.
  const status = data.license_key?.status;
  if (status && !["active", "inactive"].includes(status)) return { ok: false, reason: `License key is ${status}.` };
  if (!productOk(data)) return { ok: false, reason: "License key belongs to a different product." };
  if (!data.instance) return { ok: false, reason: `This activation was removed. ${ACTIVATE_HELP}` };
  if (account && data.instance.name !== instanceName(account)) {
    const where = String(data.instance.name || "").replace(/^github:/, "");
    return { ok: false, reason: `This license code was activated for "${where}", not "${account}". A key works on up to 3 GitHub accounts or organizations. ${ACTIVATE_HELP}` };
  }
  return { ok: true };
}

/** Registers one GitHub account. Returns { ok, code } or { ok: false, reason }. */
export async function activate(key, account, { fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, reason: "Give your license key: driftline activate <license-key>" };
  if (!account) return { ok: false, reason: "Could not tell which GitHub account this is for. Add --account <name>." };
  let res, data = null;
  try {
    res = await call(fetchImpl, "activate", { license_key: key.trim(), instance_name: instanceName(account) });
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: `Could not reach Lemon Squeezy: ${e.message}` };
  }
  if (!data?.activated) {
    const limit = /activation limit/i.test(data?.error || "")
      ? " This key is already used on 3 GitHub accounts. Deactivate one with `npx github:AI-Driftline/driftline deactivate <code>`, or write to hello@aidriftline.com."
      : "";
    return { ok: false, reason: `Not activated: ${String(data?.error || `HTTP ${res?.status}`).replace(/\.+$/, "")}.${limit}` };
  }
  if (!productOk(data)) return { ok: false, reason: "This key belongs to a different product." };
  return { ok: true, code: `${key.trim()}:${data.instance.id}`, used: data.license_key?.activation_usage, limit: data.license_key?.activation_limit };
}

/** Frees the slot used by a license code. */
export async function deactivate(code, { fetchImpl = fetch } = {}) {
  const { key, instanceId } = parseCode(code);
  if (!instanceId) return { ok: false, reason: "Give the license code that `driftline activate` printed (it contains a colon)." };
  let data = null;
  try {
    data = await (await call(fetchImpl, "deactivate", { license_key: key, instance_id: instanceId })).json();
  } catch (e) {
    return { ok: false, reason: `Could not reach Lemon Squeezy: ${e.message}` };
  }
  return data?.deactivated ? { ok: true } : { ok: false, reason: `Not deactivated: ${data?.error || "unknown error"}` };
}
