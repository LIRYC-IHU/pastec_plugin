import * as pdflib from "pdf-lib";
import * as CryptoJS from "crypto-js";
import * as JSZip from "jszip";
import { uint8ArrayToBase64, convertDurationToSeconds } from "./content";

const API_URL = process.env.API_URL;
const DEFAULT_KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL;
const DEFAULT_KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "pastec";
const DEFAULT_KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "pastec_plugin";

let bearerToken;
let abbottRequestContext = {
    authorization: null,
    subscriptionKey: null,
    apiVersion: "1.0",
};
let medtronicRequestContext = {
    token: null,
    clientId: null,
    xDtpc: null,
    isAssociatedClinicAccessingExpress: null,
    documentOrigin: null,
};
const processedRequestIds = new Map();
const MEDTRONIC_REQUEST_DEDUP_WINDOW_MS = 15000;
const MEDTRONIC_TRIGGER_WINDOW_MS = 15000;
let lastMedtronicPdfTrigger = null;
const suppressedMedtronicPopupTabs = new Set();

function pruneProcessedRequestIds() {
    const now = Date.now();

    for (const [requestId, timestamp] of processedRequestIds.entries()) {
        if (now - timestamp > MEDTRONIC_REQUEST_DEDUP_WINDOW_MS) {
            processedRequestIds.delete(requestId);
        }
    }
}

function hasRecentProcessedRequestId(requestId) {
    pruneProcessedRequestIds();
    const timestamp = processedRequestIds.get(requestId);

    return typeof timestamp === "number" && (Date.now() - timestamp) < MEDTRONIC_REQUEST_DEDUP_WINDOW_MS;
}

function markProcessedRequestId(requestId) {
    pruneProcessedRequestIds();
    processedRequestIds.set(requestId, Date.now());
}

function rememberMedtronicPdfTrigger(sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
        return;
    }

    lastMedtronicPdfTrigger = {
        tabId,
        frameId: typeof sender?.frameId === "number" ? sender.frameId : 0,
        timestamp: Date.now(),
        url: sender?.tab?.url || ""
    };
}

function getMedtronicPdfMessageTarget(details) {
    if (details.type === "xmlhttprequest" && typeof details.tabId === "number" && details.tabId >= 0) {
        return {
            tabId: details.tabId,
            frameId: typeof details.frameId === "number" ? details.frameId : 0
        };
    }

    if (
        lastMedtronicPdfTrigger
        && (Date.now() - lastMedtronicPdfTrigger.timestamp) < MEDTRONIC_TRIGGER_WINDOW_MS
    ) {
        return {
            tabId: lastMedtronicPdfTrigger.tabId,
            frameId: lastMedtronicPdfTrigger.frameId
        };
    }

    return null;
}

function hasRecentMedtronicPdfTrigger() {
    return Boolean(
        lastMedtronicPdfTrigger
        && (Date.now() - lastMedtronicPdfTrigger.timestamp) < MEDTRONIC_TRIGGER_WINDOW_MS
    );
}

function getRecentMedtronicSourceTabId() {
    return hasRecentMedtronicPdfTrigger() ? lastMedtronicPdfTrigger.tabId : null;
}

function isLikelyMedtronicPopupUrl(url) {
    if (typeof url !== "string" || !url) {
        return false;
    }

    if (url.startsWith("blob:")) {
        return url.includes("medtroniccarelink.net");
    }

    if (url === "about:blank") {
        return true;
    }

    try {
        const parsedUrl = new URL(url);
        return (
            /(^|\.)medtroniccarelink\.net$/i.test(parsedUrl.hostname)
            && (
                /^\/CareLink\.API\.Service\/api\/documents\/\d+$/.test(parsedUrl.pathname)
                || parsedUrl.pathname.startsWith("/carelink.web/")
            )
        );
    } catch (error) {
        return false;
    }
}

function closeMedtronicPopupTab(tabId, reason) {
    if (typeof tabId !== "number" || suppressedMedtronicPopupTabs.has(tabId)) {
        return;
    }

    const sourceTabId = getRecentMedtronicSourceTabId();
    if (tabId === sourceTabId) {
        return;
    }

    suppressedMedtronicPopupTabs.add(tabId);
    console.log("Closing Medtronic popup tab", { tabId, reason });

    chrome.tabs.remove(tabId).catch((error) => {
        console.warn("Unable to close Medtronic popup tab", { tabId, reason, error });
    }).finally(() => {
        globalThis.setTimeout(() => {
            suppressedMedtronicPopupTabs.delete(tabId);
        }, MEDTRONIC_TRIGGER_WINDOW_MS);
    });
}

function updateMedtronicRequestContext(details) {
    const headers = details.requestHeaders || [];

    for (const header of headers) {
        const name = header?.name?.toLowerCase?.() || "";
        const value = header?.value || "";

        if (name === "authorization" && /^bearer\s+/i.test(value)) {
            const nextToken = value.replace(/^bearer\s+/i, "");
            if (nextToken) {
                bearerToken = nextToken;
                medtronicRequestContext.token = nextToken;
            }
            continue;
        }

        if (name === "client-id" && value) {
            medtronicRequestContext.clientId = value;
            continue;
        }

        if (name === "x-dtpc" && value) {
            medtronicRequestContext.xDtpc = value;
            continue;
        }

        if (name === "isassociatedclinicaccessingexpress" && value) {
            medtronicRequestContext.isAssociatedClinicAccessingExpress = value;
        }
    }

    try {
        medtronicRequestContext.documentOrigin = new URL(details.url).origin;
    } catch (error) {
        console.warn("Unable to parse Medtronic request origin", error);
    }
}

function updateAbbottRequestContext(details) {
    const headers = details.requestHeaders || [];

    for (const header of headers) {
        const name = header?.name?.toLowerCase?.() || "";
        const value = header?.value || "";

        if (name === "authorization" && /^bearer\s+/i.test(value)) {
            abbottRequestContext.authorization = value;
            continue;
        }

        if (name === "ocp-apim-subscription-key" && value) {
            abbottRequestContext.subscriptionKey = value;
            continue;
        }

        if (name === "x-api-version" && value) {
            abbottRequestContext.apiVersion = value;
        }
    }
}

function hasAbbottRequestContext() {
    return Boolean(
        abbottRequestContext.authorization
        && abbottRequestContext.subscriptionKey
    );
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

async function fetchAbbottPdf(episodeAndEgmId, websiteNotificationId) {
    if (!hasAbbottRequestContext()) {
        throw new Error("Contexte Abbott manquant. Rafraîchissez la page Abbott, attendez son chargement complet, puis réessayez.");
    }

    if (!episodeAndEgmId || !websiteNotificationId) {
        throw new Error("Paramètres Abbott manquants pour récupérer le PDF.");
    }

    const requestUrl = new URL("https://p1euapim.merlin.net/transmissions/episodes/print");
    requestUrl.searchParams.set("episodeAndEgmIds", episodeAndEgmId);
    requestUrl.searchParams.set("websiteNotificationId", websiteNotificationId);

    const requestId = `${crypto.randomUUID()}_${Date.now()}`;
    console.log("Fetching Abbott PDF directly", {
        requestUrl: requestUrl.toString(),
        episodeAndEgmId,
        websiteNotificationId,
        requestId,
    });

    const response = await fetch(requestUrl.toString(), {
        method: "GET",
        headers: {
            "Accept": "application/json, application/pdf, application/text",
            "Authorization": abbottRequestContext.authorization,
            "X-API-VERSION": abbottRequestContext.apiVersion,
            "X-Request-ID": requestId,
            "ocp-apim-subscription-key": abbottRequestContext.subscriptionKey,
        },
        referrer: "https://europe.merlin.net/",
        referrerPolicy: "strict-origin-when-cross-origin",
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Échec de récupération du PDF Abbott: ${response.status} ${errorText}`);
    }

    const contentType = response.headers.get("content-type") || "application/pdf";
    const base64 = arrayBufferToBase64(await response.arrayBuffer());

    return {
        base64,
        contentType,
        requestUrl: requestUrl.toString(),
    };
}

function normalizeUrl(value) {
    return value.trim().replace(/\/+$/, "");
}

function base64UrlEncode(bytes) {
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded);
}

function decodeToken(token) {
    const payload = token.split(".")[1];
    if (!payload) {
        throw new Error("Invalid access token payload");
    }
    return JSON.parse(decodeBase64Url(payload));
}

function isTokenStillValid(token) {
    if (!token) {
        return false;
    }

    try {
        const payload = decodeToken(token);
        return typeof payload.exp === "number" && payload.exp > (Date.now() / 1000) + 30;
    } catch (error) {
        console.warn("Unable to decode stored token:", error);
        return false;
    }
}

function extractScopedValues(groups, scopeName) {
    if (!Array.isArray(groups)) {
        return [];
    }

    return groups
        .filter(group => typeof group === "string" && group.startsWith(`/${scopeName}/`))
        .map(group => group.split("/").pop())
        .filter(Boolean);
}

function buildFallbackUser(accessToken) {
    const payload = decodeToken(accessToken);
    const clientRoles = Object.values(payload.resource_access || {})
        .flatMap(resource => Array.isArray(resource?.roles) ? resource.roles : []);
    const realmRoles = Array.isArray(payload.realm_access?.roles) ? payload.realm_access.roles : [];
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    const centers = Array.isArray(payload.centers) ? payload.centers : extractScopedValues(groups, "centers");
    const projects = Array.isArray(payload.projects) ? payload.projects : extractScopedValues(groups, "projects");

    return {
        username: payload.preferred_username || payload.name || "",
        email: payload.email || "",
        roles: [...new Set([...realmRoles, ...clientRoles])],
        realm_roles: realmRoles,
        client_roles: clientRoles,
        centers,
        projects,
        primary_center: payload.primary_center || centers[0] || "",
        user_type: payload.user_type || "",
    };
}

async function getAuthConfig(overrides = {}) {
    const stored = await chrome.storage.local.get([
        "api_url",
    ]);

    const apiUrl = normalizeUrl(overrides.apiUrl || stored.api_url || API_URL);
    const keycloakBaseUrl = normalizeUrl(
        overrides.keycloakBaseUrl
        || DEFAULT_KEYCLOAK_BASE_URL
        || `${new URL(apiUrl).origin}/auth`
    );
    const realm = (overrides.realm || DEFAULT_KEYCLOAK_REALM).trim();
    const clientId = (overrides.clientId || DEFAULT_KEYCLOAK_CLIENT_ID).trim();

    return {
        apiUrl,
        keycloakBaseUrl,
        realm,
        clientId,
        authorizationUrl: `${keycloakBaseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/auth`,
        tokenUrl: `${keycloakBaseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    };
}

async function sha256Base64Url(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return base64UrlEncode(new Uint8Array(digest));
}

function createCodeVerifier() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return base64UrlEncode(randomBytes);
}

function createState() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    return base64UrlEncode(randomBytes);
}

async function launchWebAuthFlow(url) {
    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive: true }, redirectedUrl => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            if (!redirectedUrl) {
                reject(new Error("No redirect URL received from Keycloak"));
                return;
            }

            resolve(redirectedUrl);
        });
    });
}

async function loadUserAccess(apiUrl, accessToken) {
    const response = await fetch(`${apiUrl}/users/me/access`, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Unable to fetch user access profile: ${response.status}`);
    }

    return response.json();
}

async function persistAuthSession(config, tokenData) {
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || "";
    let user;

    try {
        user = await loadUserAccess(config.apiUrl, accessToken);
    } catch (error) {
        console.warn("Unable to resolve user access from backend, falling back to token payload:", error);
        user = buildFallbackUser(accessToken);
    }

    const updates = {
        api_url: config.apiUrl,
        token: accessToken,
        refresh_token: refreshToken,
        user_access: user,
    };

    if (user?.primary_center) {
        updates.center = user.primary_center.trim().toLowerCase();
    }

    await chrome.storage.local.set(updates);
    return user;
}

async function clearAuthSession() {
    await chrome.storage.local.remove(["token", "refresh_token", "user_access"]);
}

async function exchangeAuthorizationCode(config, code, codeVerifier, redirectUri) {
    console.log("[PASTEC auth] Exchanging authorization code", {
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        realm: config.realm,
        redirectUri,
        codeLength: code.length,
        codeVerifierLength: codeVerifier.length,
    });

    const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: config.clientId,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("[PASTEC auth] Code exchange failed", {
            status: response.status,
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            realm: config.realm,
            redirectUri,
            response: errorText,
        });
        throw new Error(`Keycloak code exchange failed: ${response.status} ${errorText}`);
    }

    return response.json();
}

async function refreshAccessToken(config, refreshToken) {
    console.log("[PASTEC auth] Refreshing access token", {
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        realm: config.realm,
        refreshTokenPresent: Boolean(refreshToken),
    });

    const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: refreshToken,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("[PASTEC auth] Refresh failed", {
            status: response.status,
            tokenUrl: config.tokenUrl,
            clientId: config.clientId,
            realm: config.realm,
            response: errorText,
        });
        throw new Error(`Keycloak token refresh failed: ${response.status} ${errorText}`);
    }

    return response.json();
}

async function authenticateWithKeycloak(overrides = {}) {
    const config = await getAuthConfig(overrides);
    const redirectUri = chrome.identity.getRedirectURL("keycloak");
    const codeVerifier = createCodeVerifier();
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state = createState();

    const authorizationUrl = new URL(config.authorizationUrl);
    authorizationUrl.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "openid profile email",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
    }).toString();

    console.log("[PASTEC auth] Starting Keycloak login", {
        apiUrl: config.apiUrl,
        keycloakBaseUrl: config.keycloakBaseUrl,
        realm: config.realm,
        clientId: config.clientId,
        authorizationUrl: config.authorizationUrl,
        tokenUrl: config.tokenUrl,
        redirectUri,
    });

    const redirectedUrl = await launchWebAuthFlow(authorizationUrl.toString());
    const redirectedLocation = new URL(redirectedUrl);

    console.log("[PASTEC auth] Redirect received", {
        redirectOrigin: redirectedLocation.origin,
        redirectPath: redirectedLocation.pathname,
        hasCode: Boolean(redirectedLocation.searchParams.get("code")),
        hasState: Boolean(redirectedLocation.searchParams.get("state")),
        hasError: Boolean(redirectedLocation.searchParams.get("error")),
        error: redirectedLocation.searchParams.get("error"),
        errorDescription: redirectedLocation.searchParams.get("error_description"),
    });

    if (redirectedLocation.searchParams.get("state") !== state) {
        throw new Error("Keycloak state validation failed");
    }

    const authorizationError = redirectedLocation.searchParams.get("error");
    if (authorizationError) {
        throw new Error(redirectedLocation.searchParams.get("error_description") || authorizationError);
    }

    const authorizationCode = redirectedLocation.searchParams.get("code");
    if (!authorizationCode) {
        throw new Error("No authorization code returned by Keycloak");
    }

    const tokenData = await exchangeAuthorizationCode(config, authorizationCode, codeVerifier, redirectUri);
    const user = await persistAuthSession(config, tokenData);

    return {
        token: tokenData.access_token,
        user,
        config,
    };
}

async function getValidAccessToken(options = {}) {
    const config = await getAuthConfig(options);
    const { token, refresh_token: refreshToken } = await chrome.storage.local.get(["token", "refresh_token"]);

    console.log("[PASTEC auth] Resolving valid token", {
        apiUrl: config.apiUrl,
        keycloakBaseUrl: config.keycloakBaseUrl,
        realm: config.realm,
        clientId: config.clientId,
        hasToken: Boolean(token),
        hasRefreshToken: Boolean(refreshToken),
        interactive: options.interactive !== false,
    });

    if (isTokenStillValid(token)) {
        console.log("[PASTEC auth] Using cached access token");
        return {
            token,
            user: (await chrome.storage.local.get(["user_access"])).user_access || null,
            config,
        };
    }

    if (refreshToken) {
        try {
            const refreshedTokens = await refreshAccessToken(config, refreshToken);
            if (!refreshedTokens.refresh_token) {
                refreshedTokens.refresh_token = refreshToken;
            }
            const user = await persistAuthSession(config, refreshedTokens);
            console.log("[PASTEC auth] Refresh succeeded");
            return {
                token: refreshedTokens.access_token,
                user,
                config,
            };
        } catch (error) {
            console.warn("Refresh token flow failed, clearing stored auth session:", error);
            await clearAuthSession();
        }
    }

    if (options.interactive === false) {
        throw new Error("Authentication required");
    }

    console.log("[PASTEC auth] Starting interactive login because no valid token is available");
    return authenticateWithKeycloak(config);
}

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL || details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
        console.log("Extension installed or updated");
    }
});

// Declarative net request removed for Chrome Web Store compatibility

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "pastec-auth-login") {
        authenticateWithKeycloak({ apiUrl: message.apiUrl }).then(result => {
            sendResponse({
                ok: true,
                token: result.token,
                user: result.user,
            });
        }).catch(error => {
            console.error("Keycloak authentication failed:", error);
            sendResponse({
                ok: false,
                error: error.message || error.toString(),
            });
        });
        return true;
    }
    if (message.action === "pastec-auth-get-valid-token") {
        getValidAccessToken({
            apiUrl: message.apiUrl,
            interactive: message.interactive,
        }).then(result => {
            sendResponse({
                ok: true,
                token: result.token,
                user: result.user,
            });
        }).catch(error => {
            console.error("Unable to get a valid Keycloak token:", error);
            sendResponse({
                ok: false,
                error: error.message || error.toString(),
            });
        });
        return true;
    }
    if (message.action === "encrypt patient data") {
        console.log("Encrypting patient data in the background");
        encryptData(message.episode_info).then(({ patientId, episodeId }) => {;
            console.log("Patient ID:", patientId);
            console.log("Episode ID:", episodeId);
            sendResponse({ patientId: patientId, episodeId: episodeId });
        }).catch((error) => {
            console.error("Error encrypting patient data: ", error);
            sendResponse({ status: "error", message: "Failed to encrypt patient data", error: error.message || error.toString() });
        });
        return true; // Indicate that the response will be sent asynchronously
    }
    if(message.action === "get episode diagnosis") {
        console.log("get episode diagnosis message received");
        getAnnotation(message.metadata).then((response) => {
            console.log(response);
            sendResponse({
                status: 'success',
                message: 'episode diagnosis correctly fetched',
                response: response
            })
        }).catch(error => {
            console.error ("error getting episode diagnosis: ", error);
        })
        return true;
    }
    if(message.action === "get episode information") {
        handleEpisodeInfo(message.metadata).then((response) => {
            console.log("response from API get episode info", response);
            sendResponse({
                status: "success",
                message: "episode information fetched successfully",
                response: response
            })
        }).catch(error => {
            console.error("error processing episode information: ", error )
            sendResponse({
                status:"error",
                message: "failed to process episode information: ",
                error: error.message || error.toString()
            });
        });
        return true;
    }
    if(message.action === "send dataObject to background") {
        handlePdfTreated(message).then(() => {
            sendResponse({status: "success", message: "Object sent to server successfully"});
        }).catch(error => {
            console.error("error processing the data object: ", error);
            sendResponse({
                status: "error", 
                message: "Failed to process the data object", 
                error: error.message || error.toString()});
        });
        return true;
    }
    if(message.action === "handle alert printing") {
        console.log("handling alert printing: ", message.message);
        handleAlertPrinting(message.message). then(() => {
        }).catch(error => {
            console.error("error printing the episode: ", error);
            });
        return true;
    }          
    if (message == "pdfData sent") {
        console.log("message received from content script");
        chrome.storage.local.get('pdfData')
            .then(data => {
                const { pdfData: { base64, textArray} } = data;
                return getDataFromPdf(textArray)
                    .then(pdfMetadataArray => {
                        return getEpisodeLength(textArray)
                            .then(lengthArray => {
                                splitPdfByEpisodes(base64, lengthArray)
                                    .then(() => {
                                        chrome.storage.local.set({pdfMetadataArray}).then(() => {
                                            sendResponse({status: "success", message: "pdf treated successfully"});
                                        })
                                    });
                            });
                    });
            })  
            .catch(error => {
                console.error(error);
            });
            return true;
    }
    if(message.action === "get cookies") {
        chrome.cookies.getAll({url: message.url}).then(response => {
            sendResponse(response)
        }).catch(error => {
            console.error ("error getting the cookies; ", error)
        });
        return true;
    }
    if (message.action === "ensure medtronic page bridge") {
        const tabId = sender?.tab?.id;
        const frameId = typeof sender?.frameId === "number" ? sender.frameId : 0;

        if (typeof tabId !== "number") {
            sendResponse({ ok: false, error: "No sender tab available for Medtronic page bridge injection" });
            return true;
        }

        chrome.scripting.executeScript({
            target: {
                tabId,
                frameIds: [frameId]
            },
            files: ["medtronic_page_bridge.js"],
            world: "MAIN"
        }).then(() => {
            console.log("Medtronic page bridge injected", { tabId, frameId });
            sendResponse({ ok: true });
        }).catch((error) => {
            console.error("Failed to inject Medtronic page bridge", error);
            sendResponse({ ok: false, error: error.message || error.toString() });
        });
        return true;
    }
    if (message.action === "get medtronic bearer token") {
        sendResponse({
            token: medtronicRequestContext.token || bearerToken || null,
            clientId: medtronicRequestContext.clientId || null,
            xDtpc: medtronicRequestContext.xDtpc || null,
            isAssociatedClinicAccessingExpress: medtronicRequestContext.isAssociatedClinicAccessingExpress || null,
            documentOrigin: medtronicRequestContext.documentOrigin || null,
        });
        return true;
    }
    if (message.action === "medtronic-pdf-click") {
        rememberMedtronicPdfTrigger(sender);
        console.log("Medtronic PDF trigger received from tab", sender?.tab?.id);
        sendResponse({ ok: true });
        return true;
    }
    if (message.action === "abbott-fetch-pdf") {
        fetchAbbottPdf(message.episodeAndEgmId, message.websiteNotificationId).then((result) => {
            sendResponse({
                ok: true,
                base64: result.base64,
                contentType: result.contentType,
                requestUrl: result.requestUrl,
            });
        }).catch((error) => {
            console.error("Unable to fetch Abbott PDF", error);
            sendResponse({
                ok: false,
                error: error.message || error.toString(),
            });
        });
        return true;
    }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    async function(details) {
        updateAbbottRequestContext(details);
        if (hasAbbottRequestContext()) {
            console.log("Abbott request context intercepted");
        }
    },
    {
        urls: [
            "https://p1euapim.merlin.net/*"
        ]
    },
    ["requestHeaders", "extraHeaders"]
  );

chrome.webRequest.onBeforeSendHeaders.addListener(
    async function(details) {
        console.log("header intercepté");
        updateMedtronicRequestContext(details);
        if (medtronicRequestContext.token) {
            console.log("Authorization header intercepted");
        }
    },
    {
        urls: [
            "https://world.medtroniccarelink.net/CareLink.API.Service/api/*",
            "https://api-nl-prod.medtroniccarelink.net/CareLink.API.Service/api/*"
        ]
    },
    ["requestHeaders", "extraHeaders"]
  );

chrome.webRequest.onHeadersReceived.addListener(
    async function(details) {
        const urlRequete = new URL(details.url);
        const components = urlRequete.pathname.split('/');
        const documentID = components.pop()
        const pattern = /\d+/ 

        if (details.method === "GET" && pattern.test(documentID) && !hasRecentProcessedRequestId(documentID)) {
            markProcessedRequestId(documentID);
            console.log("Requête API interceptée:", details.url);
            console.log("Code réponse: ", details.statusCode);
            const target = getMedtronicPdfMessageTarget(details);

            if (!target) {
                console.warn("No Medtronic tab available for intercepted PDF request");
                return;
            }

            console.log("request link being sent to content script", target);
            chrome.tabs.sendMessage(
                target.tabId,
                {
                    type: "pdfUrl",
                    requestId: documentID,
                    token: medtronicRequestContext.token || bearerToken,
                    requestUrl: details.url,
                    clientId: medtronicRequestContext.clientId || null,
                    xDtpc: medtronicRequestContext.xDtpc || null,
                    isAssociatedClinicAccessingExpress: medtronicRequestContext.isAssociatedClinicAccessingExpress || null,
                    documentOrigin: medtronicRequestContext.documentOrigin || null,
                },
                { frameId: target.frameId }
            ).catch((error) => {
                console.error("Failed to send Medtronic PDF request to content script", error);
            });
        }
    },
    {
        urls: [
            "https://world.medtroniccarelink.net/CareLink.API.Service/api/documents/*",
            "https://api-nl-prod.medtroniccarelink.net/CareLink.API.Service/api/documents/*"
        ]
    },
  );

chrome.tabs.onCreated.addListener((tab) => {
    const sourceTabId = getRecentMedtronicSourceTabId();

    if (typeof sourceTabId !== "number") {
        return;
    }

    if (tab.openerTabId === sourceTabId) {
        closeMedtronicPopupTab(tab.id, "created from Medtronic PDF click");
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const sourceTabId = getRecentMedtronicSourceTabId();

    if (typeof sourceTabId !== "number" || tabId === sourceTabId) {
        return;
    }

    const candidateUrl = changeInfo.pendingUrl || changeInfo.url || tab.pendingUrl || tab.url || "";
    const openedFromSourceTab = tab.openerTabId === sourceTabId;

    if (openedFromSourceTab && (!candidateUrl || candidateUrl === "about:blank")) {
        closeMedtronicPopupTab(tabId, "blank popup opened from Medtronic PDF click");
        return;
    }

    if ((openedFromSourceTab || isLikelyMedtronicPopupUrl(candidateUrl)) && isLikelyMedtronicPopupUrl(candidateUrl)) {
        closeMedtronicPopupTab(tabId, `popup updated to ${candidateUrl}`);
    }
});

async function getDataFromPdf(textArray) {

    let pdfDataArray = [];

    const implantModelRegex = /(?<=(Date of birth: \d{2}-[A-Z|a-z]{3}-\d{4}  ))(.*)(?=. SN:)/;
    const patientNameRegex = /\w+\W+\w+\W+\w+$/; 
    const episodeDurationRegex = /(?<=Duration:\s+)\s*(\d+)\s*(s|min|h)/;
    const episodeNumberRegex = /EGM REPORT - Episode (\d+)/;
    const episodeDateRegex = /Episode date: (\d{2}-[A-Za-z]{3}-\d{4})/;
    const episodeTypeRegex = /Rhythm: (.*?)\s+Duration:/;

    console.log(textArray[0]);

    for (const textContent of textArray) {
        const pdfData = {
            system : "Microport",
            episodeNumber : textContent.match(episodeNumberRegex)?.[1],
            episodeDate : textContent.match(episodeDateRegex)?.[1],
            episodeDuration: convertDurationToSeconds(textContent.match(episodeDurationRegex)?.[0], "Microport"),
            episodeType : textContent.match(episodeTypeRegex)?.[1],
            patientName : textContent.match(patientNameRegex)?.[0],
            implantModel : textContent.match(implantModelRegex)?.[0]
        };

        //do not create metadata for blank pages
        if(pdfData.episodeNumber) {
            pdfDataArray.push(pdfData);
        }
    }
   // duplicate removal, for multiple pages PDFs
   return pdfDataArray.filter((item, index, self) =>
   index === self.findIndex((t) => (
     t.episodeNumber === item.episodeNumber && t.episodeDate === item.episodeDate
   ))
 );
}

async function splitPdfByEpisodes(base64, episodePageCounts) {
    const sourcePdfDoc = await pdflib.PDFDocument.load(base64);
    let currentPageIndex = 0;
    let promises = [];

    for (let episodeIndex = 0; episodeIndex < episodePageCounts.length; episodeIndex++) {
        const pageCount = episodePageCounts[episodeIndex];
        const newPdfDoc = await pdflib.PDFDocument.create();
        
        for (let i = 0; i < pageCount; i++) {
            const [copiedPage] = await newPdfDoc.copyPages(sourcePdfDoc, [currentPageIndex + i]);
            newPdfDoc.addPage(copiedPage);
        }
        
        currentPageIndex += pageCount;
        const pdfBytes = await newPdfDoc.save();
        const base64String = await uint8ArrayToBase64(new Uint8Array(pdfBytes)); // S'assurer d'utiliser await ici

        const key = `file_${episodeIndex}`;
        const obj = {};
        obj[key] = base64String;

        const promise = chrome.storage.local.set(obj);
        console.log(`fichier ${key} uploadé`);
        promises.push(promise);
    }

    // Attendre que toutes les promesses soient résolues
    await Promise.all(promises);
}

async function getEpisodeLength(textArray) {
    const lengthArray = []; //contiendra la longueur de chaque épisode du PDF
    let currentEpisodeNumber = 1; // Numéro d'épisode à faire concorder avec chaque élément de textArray
    lengthArray[currentEpisodeNumber-1] = 0; //attribution d'une valeur de départ au lengthArray

    for(let i = 0; i < textArray.length; i++) {
        if(textArray[i].startsWith(`EGM REPORT - Episode ${currentEpisodeNumber}`)) {
            lengthArray[currentEpisodeNumber-1]++;
        } else if (i != textArray.length - 1) {
            currentEpisodeNumber++;
            lengthArray[currentEpisodeNumber-1]= 1; //initialise la longueur du nouvel épisode
        }
    }
    return lengthArray;
}

async function compressImagesToZip(imagesArray) {
    let zip = new JSZip();
    imagesArray.forEach((image, index) => {
        const imgData = image.split(';base64,').pop();
        zip.file(`image_${index+1}.png`, imgData, {base64:true});
    });

    const content = await zip.generateAsync({type:"blob"});
    const zipFile = new File([content], "file.zip", { type: "application/zip" });
    return zipFile;
}

async function encryptData(episode_info) {
  // Récupérer le pepper sous forme de chaîne hex
  const { pepper } = await chrome.storage.local.get("pepper");
  if (typeof pepper !== "string" || !/^[0-9a-fA-F]{64}$/.test(pepper)) {
    throw new Error("Pepper invalide ou absent : must be 64 hex chars");
  }

  // Convertir en WordArray CryptoJS
  const pepperWA = CryptoJS.enc.Hex.parse(pepper);

  // Vérifier les champs obligatoires
  const { patient_id, system, episode_type, date, time } = episode_info;
  if (!patient_id || !system || !episode_type || !date || !time) {
    throw new Error("Données manquantes pour le chiffrement");
  }

  // Construire la chaîne épisode
  const episodeString = `${patient_id}_${system}_${episode_type}_${date}_${time}`;

  // HMAC pour episodeId et patientId
  const episodeId = CryptoJS.HmacSHA256(episodeString, pepperWA).toString();
  const patientId = CryptoJS.HmacSHA256(patient_id, pepperWA).toString();

  return { patientId, episodeId };
}

async function getConfiguredApiUrl() {
    return (await getAuthConfig()).apiUrl;
}

async function uploadEgm(bearer, metadata, egm_file) {
    const apiUrl = await getConfiguredApiUrl();
    const myHeaders = new Headers();
    myHeaders.append("Authorization", `Bearer ${bearer}`);

    let file;

    if(metadata.system == "Boston" || metadata.system == "Biotronik") {
        console.log("system: ", metadata.system);
        file = new File([egm_file], `${metadata.episodeId}.svg`, { type: 'image/svg+xml' });
    } else {
        console.log("system: ", metadata.system);
        file = new File([egm_file], `${metadata.episodeId}.zip`, { type: "application/zip" });
    }

    const formdata = new FormData();
    formdata.append("system", metadata.system);
    formdata.append("patientId", metadata.patientId);
    formdata.append("episodeId", metadata.episodeId);
    formdata.append("episodeType", metadata.episodeType);
    formdata.append("episodeDuration", metadata.episodeDuration);
    formdata.append("model", metadata.implantModel)
    formdata.append("EGM", file);

    console.log(metadata.episodeId, metadata.patientId, metadata.episodeDuration, metadata.episodeType, metadata.implantModel, file);

    const requestOptions = {
        method: "POST",
        headers: myHeaders,
        body: formdata,
        redirect: "follow"
    };

    try {
        const response = await fetch(`${apiUrl}/upload/egm`, requestOptions);
        const contentType = response.headers.get("content-type");

        let responseBody;
        if (contentType && contentType.includes("application/json")) {
            responseBody = await response.json();  // Parse JSON if the response is JSON
        } else {
            responseBody = await response.text();  // Otherwise, treat as text
        }

        if (!response.ok) {
            throw new Error(`Error uploading the EGM: ${response.status} ${response.statusText} - ${JSON.stringify(responseBody)}`);
        }

        return {
            status: response.status,
            headers: response.headers,
            body: responseBody
        };
    } catch (error) {
        console.error("Failed to upload EGM:", error);
        console.log(error);
    }
}

async function saveUserAnnotation(bearer, metadata) {
    try {
        const apiUrl = await getConfiguredApiUrl();
        const myHeaders = new Headers();
        myHeaders.append("Authorization", `Bearer ${bearer}`);
    
        const formdata = new FormData();
        formdata.append("system", `${metadata.system}`);
        formdata.append("patientId", `${metadata.patientId}`);
        formdata.append("episodeId", `${metadata.episodeId}`);
        formdata.append("diagnosis", `${metadata.diagnosis}`);
    
        const requestOptions = {
        method: "POST",
        headers: myHeaders,
        body: formdata,
        redirect: "follow"
        };
    
        const response = await fetch(`${apiUrl}/user/annotations/new?alert=${metadata.isAlert}`, requestOptions);
        return await response.json();  
    } catch (error) {
        console.error("error sending the annotation: ", error);
        return error;
    }

}

async function getAnnotation(metadata) {
    const apiUrl = await getConfiguredApiUrl();
    const { token } = await getValidAccessToken();
    const myHeaders = new Headers();
    myHeaders.append("accept", "application/json");
    myHeaders.append("Authorization", `Bearer ${token}`);
    
    const requestOptions = {
      method: "GET",
      headers: myHeaders,
      redirect: "follow"
    };
    
    const response = await fetch(`${apiUrl}/user/annotation/get?system=${metadata.system}&patientId=${metadata.patientId}&episodeID=${metadata.episodeId}`, requestOptions);
    if (!response.ok) {
        const error = await response.text();
        console.error("error getting episode annotation: ", error)
        return false;
    }
    else {
        const json = await response.json();
        console.log("json:", json);
        return json[json.length-1].annotation;
    }
}

async function handlePdfTreated(message) {
    const dataObject = message.dataObject;
    console.log("Data received from the content script:", dataObject);

    try {
        if (["Medtronic", "Microport", "Abbott"].includes(dataObject.metadata.system)) {
            const zipFile = await compressImagesToZip(dataObject.files);
            dataObject.files = zipFile;
        } else if (["Biotronik", "Boston"].includes(dataObject.metadata.system)) {
            const blob = new Blob([dataObject.files], {type: 'image/svg+xml'});
            
            dataObject.files = blob;
        }

        if (dataObject.metadata.isAlert) {
            const response_alert = await handleAlertList(dataObject);
            if (response_alert) {
                console.log("Alert list handled successfully");
                const array = await chrome.storage.local.get("Alert Array");
                console.log("Alert Array:", array);
            }
        }

        const { token } = await getValidAccessToken();
        console.log("Authentication successful");
        if (!dataObject.isAnnotated) {
            const uploadResponse = await uploadEgm(token, dataObject.metadata, dataObject.files);
            console.log("Upload response:", uploadResponse);
        } else {
            console.log("Episode already annotated, not uploading again.");
        }

        if (dataObject.metadata.diagnosis) {
            const annotationResponse = await saveUserAnnotation(token, dataObject.metadata);
            console.log("Annotation response:", annotationResponse);
        } else {
            console.log("No new diagnosis made for this episode.");
        }
    } catch (error) {
        console.error("Error processing the data object:", error);
        throw error;  // Re-throw the error after logging it
    }
}

async function handleAlertList(dataObject) {
    try {
        console.log("handling the alert");
        const result = await chrome.storage.local.get("alertArray");
        let alertArray = result.alertArray;
        let constructedUrl = "";
        let dateParam = encodeURIComponent(dataObject.metadata.episodeDate);
        console.log(dataObject.metadata);
        console.log(dateParam);

        if (!alertArray) {
            console.log("No alert array created on this post, creating a new one");
            alertArray = []; // Initialize the array if it does not exist.
        }

        switch (dataObject.metadata.system) {
            case 'Biotronik':
                console.log(dataObject.metadata.svg);
                const parameters = new URLSearchParams(dataObject.metadata.svg);
                constructedUrl = `https://www.biotronik-homemonitoring.com/hmsc_guiWeb/patient/monitoring/DisplayPatientContext.jsf?TopTabIdentifier=HOLTER&LowTabIdentifier=HOLTER_EPISODE&PatientIdentifier=${parameters.get("patient")}&extparam=${dateParam}`;
            break;
            case 'Boston':
                constructedUrl = `${dataObject.metadata.url}/${dateParam}`;
            break;
            case 'Medtronic': 
                constructedUrl = `${dataObject.metadata.url}/${dateParam}`;
            break;
        }

        alertArray.push(constructedUrl); // Add the new URL.
        console.log(alertArray);
        // Save the updated array back to local storage.
        await chrome.storage.local.set({ "alertArray": alertArray });
        return true;
    } catch (error) {
        console.error("Error handling the alert list:", error);
        return false;
    }
}

async function handleAlertPrinting(metadata) {

    console.log("metadata episode link: ", metadata.episodeLink);

    switch (metadata.system) {
        case "Boston":
        case "Medtronic":
            console.log("boston system detected for printing the alert");
            chrome.tabs.create({url: metadata.episodeLink, active: false});
            break;
        case "Microport":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Biotronik":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Abbott":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        default:
            console.error("error: invalid manufacturer: ", metadata.system);
            break;
    }
}
