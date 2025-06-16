console.log("script initialized");
const button = document.querySelector("#submit-button");

// options.js
document.addEventListener("DOMContentLoaded", async() => {
    const fileInput = document.querySelector("#pepper-file");
    const pepperField = document.querySelector("#pepper");
    const submitBtn = document.querySelector("#submit-button");

    if(pepperField) {
        const { pepper }  = await chrome.storage.local.get("pepper");
        pepperField.value = pepper || "";
            if (/^[0-9a-fA-F]{64}$/.test(pepperField.value)) {
                console.log("Pepper is valid:", pepperField.value);
                submitBtn.disabled = false; // Enable the button if pepper is valid
            }
    }


    fileInput.addEventListener("change", async e => {
        console.log("File input changed");
        const file = e.target.files[0];
        const reader = new FileReader();
        
        reader.onload = async() => {
            const content = reader.result;
            // check that content is 64 characters hexadecimal
            if (/^[0-9a-fA-F]{64}$/.test(content)) {
                pepperField.value = content.trim();
                await chrome.storage.local.set({ "pepper": content.trim() });
                submitBtn.disabled = false; // Enable the button if pepper is valid
                console.log("Pepper set successfully:", content.trim());
                window.alert("Le fichier de pepper a été chargé avec succès.");
            } else {
                pepperField.value = "";
                submitBtn.disabled = true; // Disable the button if pepper is invalid
                window.alert("Le fichier de pepper n'est pas valide");
            }
        }
        reader.readAsText(file);
        });
});


if (button) {  // Always check if the element exists
    button.addEventListener('click', async () => {
        const usernameField = document.querySelector("#username");
        const passwordField = document.querySelector("#password");
        const pepperField = document.querySelector("#pepper");
        const urlField = document.querySelector("#url");

        // assign value to pepperField if it exists
        const pepper = await chrome.storage.local.get("pepper");
        if (pepperField && pepper.pepper) {
            pepperField.value = pepper.pepper;
        } else {
            pepperField.value = ""; // or handle it as needed
        }

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
                document.querySelector("#auth-status").textContent = `Échec de l'authentification: ${response.statusText}`;
            } else {
                console.log("Authentication successful");
                const data = await response.json();
                const bearer = data.access_token;
                document.querySelector("#auth-status").textContent = 'Authentification réussie';
                await chrome.storage.local.set({
                    username: usernameField.value,
                    password: passwordField.value,
                    token: data.access_token,
                    refresh_token: data.refresh_token});
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

