document.addEventListener('DOMContentLoaded', async() => {
    console.log("popup.js script initialized");
    const objectArray = await chrome.storage.local.get("alertArray");
    const aiCheckState = await chrome.storage.local.get("aiCheck");
    console.log(`${aiCheckState.aiCheck} upon loading popup`);
    const aiCheck = document.querySelector("#ai-check");
    if (aiCheckState.aiCheck === undefined) {
        aiCheck.checked = false;
        await chrome.storage.local.set({ "aiCheck": false });
    } else {
        aiCheck.checked = aiCheckState.aiCheck;
    }
    const alertArray = objectArray.alertArray;

    console.log(typeof(alertArray));

    if(!alertArray) {
        document.querySelector("#text").textContent = `Aucune alerte en attente de transmission `;
    } else {
        document.querySelector("#text").textContent = `${alertArray.length} alertes sont en attente de transmission`;
    }

    const notification = document.querySelector("#notify-button");
    notification.addEventListener('click', async() => {
        await copyAlertsToClipboard(alertArray);
    });
    const cleanButton = document.querySelector("#clean-alerts");
    cleanButton.addEventListener('click', () => {
        if(window.confirm("Êtes-vous sûr(e) de vouloir supprimer toutes les alertes non envoyées?")){
            chrome.storage.local.remove("alertArray", () => {
                console.log('Alert list cleared');
                document.querySelector("#text").textContent = `0 alertes sont en attente de visualisation`;
            });
        }
    });

    aiCheck.addEventListener('change', async() => {
        const isChecked = aiCheck.checked;
        await chrome.storage.local.set({ "aiCheck": isChecked });
        console.log(`AI check set to: ${isChecked}`);
    });
})

async function copyAlertsToClipboard(urlsArray) {
    if (!urlsArray || urlsArray.length === 0) {
        console.error("No URLs found in local storage.");
        alert("Aucune URL à envoyer.");
        return;
    }

    const text = `Voici les alertes EGM nécessitant d'être revues: \n\n${urlsArray.join('\n\n')}`;
    try {
        await navigator.clipboard.writeText(text);
        console.log('Text copied to clipboard successfully!');
        openMailto('ben.scrstn@gmail.com', text);
    } catch (err) {
        console.error('Could not copy text: ', err);
        alert("Erreur lors de la copie des URLs dans le presse-papiers.");
    }
}

function openMailto(email) {
    const subject = encodeURIComponent("Liste des EGM en attente de revue");
    const body = encodeURIComponent("[Veuillez faire CRTL+V pour coller le contenu]");
    window.open(`mailto:${email}?subject=${subject}&body=${body}`);
}


