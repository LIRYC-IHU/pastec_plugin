export async function authenticateUser() {

    const username = await chrome.storage.local.get("username");
    const password = await chrome.storage.local.get("password");

    console.log("username: ", username);
    console.log("password: ", password);

    // open options.html if no username or password

    if(!username || !password) {
        console.error("No username or password found.");
        chrome.tabs.create({url: "options.html"});
        return;
    }

    try {
        const response = await fetch("http://127.0.0.1:8000/users/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                "username": username.username,
                "password": password.password,
            }),
        });
        
        if (!response.ok) {
            throw new Error("Failed to authenticate");
        }

        const data = await response.json();
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        localStorage.setItem("token_expiry", Date.now() + data.expires_in); 
        return data.access_token;
    } catch (error) {
        console.error("Authentication error:", error);
    }

}

export async function getValidToken() {
    const access_token = localStorage.getItem("access_token");
    const tokenExpiry = localStorage.getItem("token_expiry");

    if (access_token && tokenExpiry && Date.now() < tokenExpiry) {
        return access_token;
    } else {
        const refreshToken = localStorage.getItem("refresh_token");
        console.log("Refresh token trouvé:", refreshToken); // Debug

        if (refreshToken) {
            try {
                // Modifier le format pour correspondre à ce qu'attend le serveur
                const formData = new URLSearchParams();
                formData.append('refresh_token', refreshToken);

                const response = await fetch("http://127.0.0.1:8000/users/token/refresh", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: formData
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("Token refresh failed. Status:", response.status);
                    console.error("Error details:", errorText);
                    try {
                        console.debug("No refresh token available; trying to authenticate user.")
                        return await authenticateUser();
                    } catch (error) {
                        console.error("Error in getValidToken:", error);
                    }
                }

                const data = await response.json();
                localStorage.setItem("access_token", data.access_token);
                localStorage.setItem("refresh_token", data.refresh_token);
                localStorage.setItem("token_expiry", Date.now() + 30 * 60 * 1000);
                return data.access_token;
            } catch (error) {
                console.error("Erreur lors du refresh token:", error);
                throw error;
            }
        } 
    }
}

export async function authenticatedFetch(url, options) {
    try {
        const access_token = await getValidToken();
        if (!access_token) {
            throw new Error("No valid token available.");
        }

        options.headers = {
            ...options.headers,
            "Authorization": `Bearer ${access_token}`,
        };
        return await fetch(url, options);
    } catch (error) {
        console.error("Error in authenticatedFetch:", error);
        throw error;
    }
}