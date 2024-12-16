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

        const response = await fetch("http://musicp.chu-bordeaux.fr:9000/api/connect/keycloak", {
            body: `username=${encodeURIComponent(usernameField.value)}&password=${encodeURIComponent(passwordField.value)}`,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            method: "POST"
        });

        if (!response.ok) {
            console.error("Authentication failed:", response.statusText);
            document.querySelector("#auth-failure").style.display = "block";  // Use "block" not "true"
            usernameField.value = "";
            passwordField.value = "";
        } else {
            console.log("Authentication successful");
            document.querySelector("#auth-success").style.display = "block";  // Use "block" not "true"
            chrome.storage.local.set({"credentials": {username: usernameField.value, password: passwordField.value}});
            usernameField.value = "";
            passwordField.value = "";
        }
    });
} else {
    console.error("Submit button not found.");
}

