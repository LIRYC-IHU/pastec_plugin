async function authenticateUser() {

    const { username, password } = await chrome.storage.local.get(["username", "password"]);

    if (!username || !password) {
        console.log("Username or password missing from storage.");
        window.alert("Identifiant ou mot de passe manquant : impossible de s'identifier: veuillez vous connecter à l'application");
    }

    try {
        const response = await fetch("http://127.0.0.1:8000/users/login", {
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

    //si le token est toujours valide, retourner le token
    if (token && Date.now() < expiryTime) {
        return token;
    } else {
        console.debug("Token expired, refreshing token...");
        try {
            const response = await fetch("http://127.0.0.1:8000/users/token/refresh", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    "refresh_token": refreshToken
                })
            });
    
            if (!response.ok) {
                console.debug("Token refresh failed:", response.statusText);
                console.log("trying to authenticate user:");
                const access_token = await authenticateUser();
                return access_token;
            }

            const data = await response.json();
            localStorage.setItem("token", data.access_token);
            localStorage.setItem("refresh_token", data.refresh_token);
            localStorage.setItem("expiry_time", Date.now()+data.expires_in);

            return data.access_token;

        } catch (error) {
            console.error("Error refreshing token:", error);
            throw error;
        }
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
