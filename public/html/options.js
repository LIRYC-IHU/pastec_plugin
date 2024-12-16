console.log("script initialized");
const button = document.querySelector("#submit-button");

if (button) {  // Always check if the element exists
    button.addEventListener('click', async () => {
        const usernameField = document.querySelector("#username");
        const passwordField = document.querySelector("#password");

        if (!usernameField || !passwordField) {
            console.error("Username or password field is missing.");
            return;
        }

        console.log("Attempting to log in with:", usernameField.value, passwordField.value);
        try {
            const response = await fetch("http://127.0.0.1:8000/users/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Access-Control-Allow-Origin": "*",
                },
                body: new URLSearchParams({
                    "username": usernameField.value,
                    "password": passwordField.value,
                }),
            });
    
            if (!response.ok) {
                console.error("Authentication failed:", response.statusText);
                document.querySelector("#auth-failure").style.display = "block";  // Use "block" not "true"
                usernameField.value = "";
                passwordField.value = "";
            } else {
                console.log("Authentication successful");
                const data = await response.json();
                const bearer = data.access_token;
                document.querySelector("#auth-success").style.display = "block";  // Use "block" not "true"
                const username_stock = await chrome.storage.local.set({"username": usernameField.value});
                const password_stock = await chrome.storage.local.set({"password": passwordField.value});
                const token_stock = await chrome.storage.local.set({"token": bearer});
                const token_expiry_stock = await chrome.storage.local.set({"token_expiry": Date.now() + 30 * 60 * 1000}); // 30 minutes
            }
        } catch(error) {
            console.error("error setting up credentials: ", error);
            window.alert("Identifiant ou mot de passe incorrect : impossible de s'identifier");
            usernameField.value = "";
            passwordField.value = "";
        }

    });
} else {
    console.error("Submit button not found.");
}

async function setStorageData(data) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(data, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve();
            }
        });
    });
}

