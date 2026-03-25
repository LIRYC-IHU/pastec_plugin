const DEFAULT_API_URL = process.env.API_URL;

function normalizeUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

async function getApiUrl() {
  const { api_url } = await chrome.storage.local.get(["api_url"]);
  return normalizeUrl(api_url || DEFAULT_API_URL);
}

async function sendAuthMessage(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...extra });
  if (!response?.ok) {
    throw new Error(response?.error || "Authentication request failed");
  }
  return response;
}

async function computePepperFingerprint(pepper) {
  const normalizedPepper = pepper.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalizedPepper);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getPluginAccessHeaders() {
  const { pepper, center } = await chrome.storage.local.get(["pepper", "center"]);
  const headers = {};

  if (typeof center === "string" && center.trim()) {
    headers["X-PASTEC-Center"] = center.trim().toLowerCase();
  }

  if (typeof pepper === "string" && /^[0-9a-fA-F]{64}$/.test(pepper.trim())) {
    headers["X-PASTEC-Pepper-Fingerprint"] = await computePepperFingerprint(pepper);
  }

  return headers;
}

export async function authenticateUser() {
  const apiUrl = await getApiUrl();
  const response = await sendAuthMessage("pastec-auth-login", { apiUrl });
  return response.token;
}

async function getValidToken() {
  const apiUrl = await getApiUrl();
  const response = await sendAuthMessage("pastec-auth-get-valid-token", { apiUrl });
  return response.token;
}

export async function authenticatedFetch(url, options = {}) {
  const apiUrl = await getApiUrl();
  const token = await getValidToken();
  const pluginHeaders = await getPluginAccessHeaders();
  const normalizedDefaultApiUrl = normalizeUrl(DEFAULT_API_URL);
  const targetUrl = typeof url === "string" && url.startsWith(normalizedDefaultApiUrl)
    ? `${apiUrl}${url.slice(normalizedDefaultApiUrl.length)}`
    : url;
  const headers = {
    ...options.headers,
    ...pluginHeaders,
    "Authorization": `Bearer ${token}`
  };
  const res = await fetch(targetUrl, { ...options, headers });
  if (!res.ok) {
    throw new Error(`Fetch failed with status ${res.status}`);
  }
  return res;
}
