// Pro features (drift tests) need a Lemon Squeezy license key.
// API: POST https://api.lemonsqueezy.com/v1/licenses/validate (form field: license_key)

// Fill in after creating the Driftline product in Lemon Squeezy, so keys for
// other products in other stores are rejected. Empty = accept any valid key.
export const DRIFTLINE_PRODUCT_IDS = [];

export async function checkLicense(key, { fetchImpl = fetch } = {}) {
  if (!key) return { ok: false, reason: "No license key. The scan ran; drift tests need Driftline Pro." };
  let res;
  try {
    res = await fetchImpl("https://api.lemonsqueezy.com/v1/licenses/validate", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ license_key: key }).toString(),
    });
  } catch (e) {
    // Do not punish paying users for a network blip: allow the run and say so.
    return { ok: true, reason: `License server unreachable (${e.message}); drift tests ran anyway.` };
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!data.valid) return { ok: false, reason: `License key not valid${data.error ? `: ${data.error}` : ""}.` };
  if (data.license_key?.status && !["active"].includes(data.license_key.status)) {
    return { ok: false, reason: `License key is ${data.license_key.status}.` };
  }
  if (DRIFTLINE_PRODUCT_IDS.length && !DRIFTLINE_PRODUCT_IDS.includes(data.meta?.product_id)) {
    return { ok: false, reason: "License key belongs to a different product." };
  }
  return { ok: true };
}
