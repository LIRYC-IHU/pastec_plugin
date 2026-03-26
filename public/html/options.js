console.log("options script initialized");

const button = document.querySelector("#submit-button");
const OPTIONAL_API_ORIGINS = new Set([
    "http://localhost:8000/*",
    "http://localhost:8080/*",
]);

function normalizeUrl(value) {
    return value.trim().replace(/\/+$/, "");
}

function getOriginPermissionPattern(value) {
    const normalizedValue = normalizeUrl(value);
    if (!normalizedValue) {
        return null;
    }

    try {
        return `${new URL(normalizedValue).origin}/*`;
    } catch (error) {
        return null;
    }
}

async function ensureOptionalApiHostPermission(value) {
    const originPattern = getOriginPermissionPattern(value);
    if (!originPattern || !OPTIONAL_API_ORIGINS.has(originPattern)) {
        return;
    }

    const permissions = { origins: [originPattern] };
    const alreadyGranted = await chrome.permissions.contains(permissions);
    if (alreadyGranted) {
        return;
    }

    const granted = await chrome.permissions.request(permissions);
    if (!granted) {
        throw new Error("L'autorisation d'acces au serveur local a ete refusee.");
    }
}

function setAuthStatus(message) {
    const authStatus = document.querySelector("#auth-status");
    if (authStatus) {
        authStatus.textContent = message;
    }
}

function canonicalJson(data) {
    const sortedEntries = Object.entries(data).sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(Object.fromEntries(sortedEntries));
}

function base64UrlToUint8Array(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function base64ToUint8Array(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function pemToArrayBuffer(pem) {
    const base64 = pem
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s+/g, "");
    return base64ToUint8Array(base64).buffer;
}

async function importVerificationKey(pem) {
    return crypto.subtle.importKey(
        "spki",
        pemToArrayBuffer(pem),
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
        },
        false,
        ["verify"]
    );
}

async function fetchBundleVerificationKey(baseUrl) {
    const response = await fetch(`${baseUrl}/users/config-bundle/public-key`, {
        method: "GET",
    });
    if (!response.ok) {
        throw new Error(`Unable to fetch provisioning public key: ${response.status}`);
    }
    return response.text();
}

async function verifySignedBundle(bundle, baseUrl) {
    if (!bundle || typeof bundle !== "object") {
        throw new Error("Invalid bundle format");
    }

    if (bundle.algorithm !== "RS256") {
        throw new Error("Unsupported bundle signature algorithm");
    }

    if (!bundle.payload || typeof bundle.payload !== "object") {
        throw new Error("Provisioning bundle payload is missing");
    }

    const payload = bundle.payload;
    if (payload.kind !== "pastec-center-config" || payload.version !== 1) {
        throw new Error("Unsupported provisioning bundle type");
    }

    if (typeof payload.pepper !== "string" || !/^[0-9a-fA-F]{64}$/.test(payload.pepper.trim())) {
        throw new Error("Provisioning bundle contains an invalid pepper");
    }

    if (typeof payload.center !== "string" || !payload.center.trim()) {
        throw new Error("Provisioning bundle center is invalid");
    }

    if (typeof bundle.signature !== "string" || !bundle.signature.trim()) {
        throw new Error("Provisioning bundle signature is missing");
    }

    const publicKeyPem = await fetchBundleVerificationKey(baseUrl);
    const verificationKey = await importVerificationKey(publicKeyPem);
    const payloadBytes = new TextEncoder().encode(canonicalJson(payload));
    const signatureBytes = base64UrlToUint8Array(bundle.signature);

    const isValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        verificationKey,
        signatureBytes,
        payloadBytes
    );

    if (!isValid) {
        throw new Error("Provisioning bundle signature is invalid");
    }

    return payload;
}

async function handleProvisioningFile(file, baseUrl) {
    const content = await file.text();
    const trimmedContent = content.trim();

    if (!trimmedContent) {
        throw new Error("Provisioning file is empty");
    }

    if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error("Only signed JSON provisioning bundles are accepted");
    }

    const bundle = JSON.parse(trimmedContent);
    return verifySignedBundle(bundle, baseUrl);
}

async function applyProvisioningPayload(payload, baseUrl) {
    const pepperField = document.querySelector("#pepper");
    const centerField = document.querySelector("#center");
    const urlField = document.querySelector("#url");
    const normalizedBaseUrl = normalizeUrl(baseUrl);

    const updates = {
        pepper: payload.pepper.trim(),
        api_url: normalizedBaseUrl,
    };

    if (payload.center) {
        updates.center = payload.center.trim().toLowerCase();
    }

    await chrome.storage.local.set(updates);

    if (pepperField) {
        pepperField.value = updates.pepper;
    }
    if (centerField && updates.center !== undefined) {
        centerField.value = updates.center;
    }
    if (urlField && payload.api_url) {
        const normalizedPayloadUrl = normalizeUrl(payload.api_url);
        urlField.value = normalizedPayloadUrl;
        updates.api_url = normalizedPayloadUrl;
    } else if (urlField && normalizedBaseUrl) {
        urlField.value = normalizedBaseUrl;
    }

    await chrome.storage.local.set({ api_url: updates.api_url });
}

async function sendRuntimeMessage(payload) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) {
        throw new Error(response?.error || "Operation failed");
    }
    return response;
}

document.addEventListener("DOMContentLoaded", async () => {
    const fileInput = document.querySelector("#pepper-file");
    const pepperField = document.querySelector("#pepper");
    const centerField = document.querySelector("#center");
    const urlField = document.querySelector("#url");

    const { pepper, center, api_url, user_access } = await chrome.storage.local.get(["pepper", "center", "api_url", "user_access"]);
    if (pepperField) {
        pepperField.value = pepper || "";
    }
    if (centerField) {
        centerField.value = center || "";
    }
    if (urlField) {
        urlField.value = api_url || normalizeUrl(urlField.value);
    }
    if (user_access?.username) {
        setAuthStatus(`Utilisateur connecte: ${user_access.username}`);
    }

    if (fileInput) {
        fileInput.addEventListener("change", async event => {
            const file = event.target.files?.[0];
            if (!file || !urlField) {
                return;
            }

            try {
                await ensureOptionalApiHostPermission(urlField.value.trim());
                const payload = await handleProvisioningFile(file, urlField.value.trim());
                await applyProvisioningPayload(payload, urlField.value.trim());
                setAuthStatus("Configuration centre importée avec succes");
                window.alert("Le fichier de configuration centre a ete charge avec succes.");
            } catch (error) {
                console.error("Provisioning import failed:", error);
                if (pepperField) {
                    pepperField.value = "";
                }
                window.alert(`Le fichier de configuration est invalide: ${error.message || error.toString()}`);
            } finally {
                fileInput.value = "";
            }
        });
    }
});

if (button) {
    button.addEventListener("click", async () => {
        const centerField = document.querySelector("#center");
        const urlField = document.querySelector("#url");

        if (!urlField) {
            console.error("Required identification fields are missing.");
            return;
        }

        const apiUrl = normalizeUrl(urlField.value);
        console.log("Attempting authentication with Keycloak");
        try {
            await ensureOptionalApiHostPermission(apiUrl);
            const response = await sendRuntimeMessage({
                action: "pastec-auth-login",
                apiUrl,
            });
            await chrome.storage.local.set({ api_url: apiUrl });

            if (centerField) {
                centerField.value = response.user?.primary_center || "";
            }

            setAuthStatus("Authentification Keycloak reussie. Importez ensuite le bundle signe du centre.");
        } catch (error) {
            console.error("Error setting up Keycloak authentication:", error);
            window.alert(`Impossible de s'identifier via Keycloak: ${error.message || error.toString()}`);
            setAuthStatus("Echec de l'authentification Keycloak.");
        }
    });
} else {
    console.error("Submit button not found.");
}
