const API_URL = process.env.API_URL;

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
  // 1) Récupère username/password depuis chrome.storage.local
  const { username, password } = 
    await chrome.storage.local.get(["username", "password"]);

  if (!username || !password) {
    window.alert(
      "Identifiant ou mot de passe manquant ; veuillez vous connecter à l'application."
    );
    throw new Error("Missing credentials");
  }

  // 2) Appel login
  const res = await fetch(`${API_URL}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password })
  });
  if (!res.ok) {
    throw new Error(`Authentication failed: ${res.status}`);
  }
  const data = await res.json();

  // 3) Stocke les deux tokens
  await chrome.storage.local.set({
    center: data.user?.primary_center || "",
    token: data.access_token,
    refresh_token: data.refresh_token
  });

  return data.access_token;
}

async function getValidToken() {
  // 1) Lecture atomique des tokens
  const { token, refresh_token } = 
    await chrome.storage.local.get(["token", "refresh_token"]);

  // 2) Si pas de token ou pas de refresh_token → login
  if (!token || !refresh_token) {
    console.log("Authentication required");
    return authenticateUser();
  }

  // 3) Vérifie l'expiration
  let payload;
  try {
    payload = decode_token(token);
  } catch {
    console.warn("Impossible de décoder le token, on reloge");
    return authenticateUser();
  }

  if (payload.exp > Date.now() / 1000) {
    // 4) Token encore valide
    return token;
  }

  // 5) Token expiré → tentative de refresh
  console.log("Refreshing authentication");
  const refreshRes = await fetch(`${API_URL}/users/token/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token })
  });

  if (refreshRes.ok) {
    const data = await refreshRes.json();
    const newToken = data.access_token;
    const newRefresh = data.refresh_token || refresh_token;

    // 6) Met à jour le stockage
    await chrome.storage.local.set({
      token: newToken,
      refresh_token: newRefresh
    });
    console.log("Authentication refreshed successfully");
    return newToken;
  }

  // 7) Échec du refresh (invalid_grant…) → purge et relogin
  console.warn("Authentication expired, please log in again");
  await chrome.storage.local.remove(["token", "refresh_token"]);
  return authenticateUser();
}

export async function authenticatedFetch(url, options = {}) {
  const token = await getValidToken();
  const pluginHeaders = await getPluginAccessHeaders();
  const headers = {
    ...options.headers,
    ...pluginHeaders,
    "Authorization": `Bearer ${token}`
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    throw new Error(`Fetch failed with status ${res.status}`);
  }
  return res;
}

function decode_token(token) {
  if (!token) throw new Error("No token to decode");
  const b64 = token.split(".")[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const json = atob(b64);
  return JSON.parse(json);
}
