export async function authenticateUser() {

    const { username, password } = await chrome.storage.local.get(["username", "password"]);

    if (!username || !password) {
        console.log("Username or password missing from storage.");
        window.alert("Identifiant ou mot de passe manquant : impossible de s'identifier: veuillez vous connecter à l'application");
    }

    try {
        const response = await fetch(`${process.env.API_URL}/users/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                "username": username,
                "password": password
            })
        });

        if (!response.ok) {
            throw new Error("Authentication failed");
        }

        const data = await response.json();
        localStorage.setItem("token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        localStorage.setItem("expiry_time", Date.now()+data.expires_in);
        return data;
    } catch (error) {
        console.error("Error during authentication:", error);
        throw error;
    }
}

async function getValidToken() {
    const token = localStorage.getItem("token");
    const refreshToken = localStorage.getItem("refresh_token");
    const expiryTime = localStorage.getItem("expiry_time");

    console.log("Debug token expiration:", {
        currentTime: Date.now(),
        expiryTime: expiryTime,
        timeLeft: expiryTime - Date.now(),
        isExpired: Date.now() >= expiryTime
    });

    // Si le token est toujours valide, le retourner
    if (token && Date.now() < expiryTime) {
        return token;
    }

    // Tenter de rafraîchir le token
    if (refreshToken) {
        console.log(refreshToken)
        try {
            const response = await fetch(`http://${process.env.API_URL}/users/token/refresh`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    "refresh_token": refreshToken
                })
            });

            if (!response.ok) {
                throw new Error(`Token refresh failed: ${response.statusText}`);
            }

            const data = await response.json();
            
            // Vérifier si le token de rafraîchissement a bien fonctionné
            if (data.access_token && data.expires_in) {
                localStorage.setItem("token", data.access_token);
                localStorage.setItem("refresh_token", data.refresh_token || refreshToken);
                localStorage.setItem("expiry_time", Date.now() + data.expires_in * 1000);
                console.log("Token successfully refreshed.");
                return data.access_token;
            } else {
                throw new Error("Invalid token response during refresh.");
            }

        } catch (error) {
            console.error("Token refresh failed:", error);
        }
    }

    // Tentative de réauthentification
    try {
        console.log("Trying to authenticate user...");
        const accessToken = await authenticateUser(); // Assurez-vous que cette fonction est définie
        return accessToken;
    } catch (error) {
        console.error("Error during authentication:", error);
        throw new Error("Authentication failed.");
    }
}

export async function authenticatedFetch(url, options = {}) {
    const token = await getValidToken();

    const response = await fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            "Authorization": `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Fetch failed with status ${response.status}`);
    }

    return response;
}
