console.log("options script initialized");

const button = document.querySelector("#submit-button");

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

    const updates = {
        pepper: payload.pepper.trim(),
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
        urlField.value = payload.api_url;
    } else if (urlField && baseUrl) {
        urlField.value = baseUrl;
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    const fileInput = document.querySelector("#pepper-file");
    const pepperField = document.querySelector("#pepper");
    const centerField = document.querySelector("#center");
    const urlField = document.querySelector("#url");

    const { pepper, center } = await chrome.storage.local.get(["pepper", "center"]);
    if (pepperField) {
        pepperField.value = pepper || "";
    }
    if (centerField) {
        centerField.value = center || "";
    }

    if (fileInput) {
        fileInput.addEventListener("change", async event => {
            const file = event.target.files?.[0];
            if (!file || !urlField) {
                return;
            }

            try {
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
        const usernameField = document.querySelector("#username");
        const passwordField = document.querySelector("#password");
        const centerField = document.querySelector("#center");
        const urlField = document.querySelector("#url");

        if (!usernameField || !passwordField || !urlField) {
            console.error("Required identification fields are missing.");
            return;
        }

        console.log("Attempting authentication");
        try {
            const response = await fetch(`${urlField.value}/users/login`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Access-Control-Allow-Origin": "*",
                },
                body: new URLSearchParams({
                    username: usernameField.value,
                    password: passwordField.value,
                }),
            });

            if (!response.ok) {
                console.error("Authentication failed:", response.statusText);
                setAuthStatus(`Echec de l'authentification: ${response.statusText}`);
                return;
            }

            const data = await response.json();
            await chrome.storage.local.set({
                username: usernameField.value,
                password: passwordField.value,
                center: data.user?.primary_center || "",
                token: data.access_token,
                refresh_token: data.refresh_token,
            });

            if (centerField) {
                centerField.value = data.user?.primary_center || "";
            }

            setAuthStatus("Authentification reussie. Importez ensuite le bundle signe du centre.");
            usernameField.value = "";
            passwordField.value = "";
        } catch (error) {
            console.error("Error setting up credentials:", error);
            window.alert("Identifiant ou mot de passe incorrect : impossible de s'identifier");
            usernameField.value = "";
            passwordField.value = "";
        }
    });
} else {
    console.error("Submit button not found.");
}
