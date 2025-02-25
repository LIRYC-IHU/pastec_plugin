console.log("script initialized");
const button = document.querySelector("#submit-button");

if (button) {  // Always check if the element exists
    button.addEventListener('click', async () => {
        const usernameField = document.querySelector("#username");
        const passwordField = document.querySelector("#password");
        const urlField = document.querySelector("#url");

        if (!usernameField || !passwordField) {
            console.error("Username or password field is missing.");
            return;
        }

        console.log("Attempting to log in with:", usernameField.value, passwordField.value, urlField.value);
        try {
            const response = await fetch(`${urlField.value}/users/login`, {
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
                await chrome.storage.local.set({
                    username: usernameField.value,
                    password: passwordField.value,
                    token: bearer});
                usernameField.value = "";
                passwordField.value = "";
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

