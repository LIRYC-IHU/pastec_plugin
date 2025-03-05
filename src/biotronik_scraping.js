import { injectGenericHTML, processViewerEpisode, fetchPdfAsBlob, blobToBase64, convertDurationToSeconds } from "./content";
import { ageAtEpisode } from "./data_formatting";
import { authenticateUser, authenticatedFetch } from "./auth";

console.log("biotronik_scraping.js script initialized");
console.log("API URL:", process.env.API_URL);
const API_URL = process.env.API_URL;

const observer = new MutationObserver((mutations, obs) => {
    const element = document.querySelector("#DisplayEpisode > table > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td.RightColumn > table > tbody > tr > td.Content > table.ChartData > tbody > tr:nth-child(2) > td > object");
    if (element) {
        initializeScript();
        obs.disconnect();
    }
});

observer.observe(document, {childList: true, subtree: true});

async function initializeScript() {
    try {
        console.log("Initializing Biotronik scraping script...");
        const allLabelsResponse = await authenticatedFetch(`${API_URL}/episode/diagnoses_labels/Biotronik`);
        const allLabels = await allLabelsResponse.json();
        const labels = allLabels.labels;    
        console.log("Labels:", labels);
        document.addEventListener("close_overlay", () => closeOverlay());

        const patientName = document.querySelector("#DisplayEpisode\\:headerPatientName").textContent;
        const implantSerial = document.querySelector("#DisplayEpisode\\:headerImplantSN").textContent;
        const birthdate = document.querySelector("#DisplayEpisode\\:headerPatientDateOfBirth").textContent;
        catchPrintButton();

        let scrapedData = {
            patientName:  patientName,
            implantSerial: implantSerial,
            implantModel: document.querySelector("#DisplayEpisode\\:headerImplantName").textContent,
            episodeDate: document.querySelector("#reportData1 > tbody > tr:nth-child(4) > td.Value").textContent,
            episodeType: document.querySelector("#reportData1 > tbody > tr:nth-child(3) > td.Value").textContent,
            episodeDuration: convertDurationToSeconds(document.querySelector("#reportData1 > tbody > tr:nth-child(6) > td.Value").textContent, "Biotronik"),
            system: 'Biotronik',
            url: window.location.href,
            svgElement: document.querySelector("#DisplayEpisode > table > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td.RightColumn > table > tbody > tr > td.Content > table.ChartData > tbody > tr:nth-child(2) > td > object").data
        }; 

        console.log("Scraped data:", scrapedData);

        await injectGenericHTML('overlay-container');
        console.log("Encrypting data for episode:", scrapedData);
        const encryptResponse = await chrome.runtime.sendMessage({
            action: "encrypt patient data",
            episode_info: {
                patient_id: scrapedData.implantSerial,
                system: scrapedData.system,
                episode_type: scrapedData.episodeType,
                date: scrapedData.episodeDate,
                time: scrapedData.episodeDuration.toString()
            }
        });

        const metadata = {
            patientName: scrapedData.patientName,
            implantSerial: scrapedData.implantSerial,
            implantModel: scrapedData.implantModel,
            episodeDate: scrapedData.episodeDate,
            birthdate: birthdate,
            episodeType: scrapedData.episodeType,
            episodeDuration: scrapedData.episodeDuration,
            system: scrapedData.system,
            patientId: encryptResponse?.patientId,
            episodeId: encryptResponse?.episodeId
        }

        console.log("Encrypted metadata:", metadata);

        const uploadEpisode = processEpisode(metadata);

        console.log("labels for episode", labels[metadata.episodeType]);

        try {
            await processViewerEpisode(metadata, labels[metadata.episodeType], uploadEpisode);
            if(document.querySelector("#DisplayEpisode\\:displayNextEpisodeTop").disabled == true){
                window.alert("tous les épisodes ont été traités");
                closeOverlay()
            } else {
                document.querySelector("#DisplayEpisode\\:displayNextEpisodeTop").click();
            };
        } catch (error) {
            console.error("erreur pendant le processing de l'episode: ", error);
        }       
    } catch (error) {
        console.error("An error occurred: ", error);
    }
}

async function catchPrintButton() {
    const print = document.querySelector("#DisplayEpisode\\:printButton");
    if(print) {
        print.addEventListener('click', async(event) => {
            event.preventDefault();
            const response =  await chrome.runtime.sendMessage({
                action: "get cookies",
                url: window.location.href
            });
            const jSessionId1 = response[0].value;
            const jSessionId2 = response[1].value;
            const bigipServer = response[2].value;

            console.log(jSessionId1, jSessionId2, bigipServer);

            const urlParams = new URLSearchParams(document.querySelector("#DisplayEpisode > table > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td.RightColumn > table > tbody > tr > td.Content > table.ChartData > tbody > tr:nth-child(2) > td > object").data);

            const patientIdentifier = urlParams.get('patient');
            console.log(patientIdentifier);

            const viewState = document.querySelector("#j_id1\\:javax\\.faces\\.ViewState\\:0").value;
            console.log(viewState);

            const api = await openPdfInNewTab(jSessionId1, jSessionId2, bigipServer, patientIdentifier, viewState);
        })
    }
}

async function openPdfInNewTab(jsid1, jsid2, bigipserver, patientIdentifier, viewstate) {

    const myHeaders = new Headers();
myHeaders.append("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7");
myHeaders.append("Content-Type", "application/x-www-form-urlencoded");
myHeaders.append("Cookie", `${jsid1}; JSESSIONID=${jsid2}; BIGipServersVUCmGWpWPVx2LnjAgiAQQ=${bigipserver}`);

const urlencoded = new URLSearchParams();
urlencoded.append("DisplayEpisode", "DisplayEpisode");
urlencoded.append("DisplayEpisode:defaultAction", "DisplayEpisode:applyGainSettings");
urlencoded.append("TopTabIdentifier", "HOLTER");
urlencoded.append("LowTabIdentifier", "HOLTER_EPISODE");
urlencoded.append("PatientIdentifier", `${patientIdentifier}`);
urlencoded.append("DisplayEpisode:filterGainRV", "2");
urlencoded.append("DisplayEpisode:bottomPrintButton", "PDF");
urlencoded.append("javax.faces.ViewState", `${viewstate}`);

const requestOptions = {
  method: "POST",
  headers: myHeaders,
  body: urlencoded,
  redirect: "follow"
};

try {
    const response = await fetch("https://www.biotronik-homemonitoring.com/hmsc_guiWeb/patient/monitoring/DisplayPatientContext.jsf", requestOptions);
    const resultHtml = await response.text();

    // Créer un nouvel onglet
    const newTab = window.open();
    if (newTab) {
        // Injecter le HTML dans le nouvel onglet
        newTab.document.open();
        newTab.document.write(resultHtml);
        newTab.document.close();
    } else {
        console.error("Impossible d'ouvrir un nouvel onglet");
    }

} catch (error) {
    console.error("Erreur lors de la récupération du PDF:", error);
}

}

async function processEpisode(metadata) {
    console.log("Processing viewer episode...");
    
    try {
        const formData = new FormData();
        formData.append("patient_id", metadata.patientId);
        formData.append("manufacturer", metadata.system.toLowerCase());
        formData.append("episode_type", metadata.episodeType);
        formData.append("age_at_episode", ageAtEpisode(metadata.episodeDate, metadata.birthdate) || 0);
        formData.append("episode_duration", metadata.episodeDuration.toString());
        formData.append("episode_id", metadata.episodeId);

        // Étape 1 : Appel à `upload_episode`
        console.log("Uploading episode metadata...");
        const response = await authenticatedFetch(`${API_URL}/episode/upload_episode`, {
            method: "POST",
            body: formData
        });

        const responseData = await response.json();
        console.log("Response data from upload_episode:", responseData);

        // Labels disponibles dans `responseData`
        const labels = responseData.labels;

        // Étape 2 : Vérifiez si l'épisode existe
        if (responseData.exists) {
            // L'épisode existe, récupérez directement les modèles IA et les jobs
            console.log("Episode exists. Using response data...");
            return {
                labels,
                ai_clients: responseData.ai_clients || [],
                jobs: responseData.jobs || []
            };
        } else {
            const svgBlob = await getSVGBlob();
            if (!svgBlob) {
                console.error("❌ Impossible de récupérer le SVG en Blob.");
                return;
            }
        
            // Vérification
            console.log("🎯 Taille du fichier SVG (Blob) :", svgBlob.size, "octets");
        
            // Préparer FormData
            const egmFormData = new FormData();
            egmFormData.append("file", svgBlob, "egm.svg");

            const episodeResponse = await authenticatedFetch(`${API_URL}/episode/${responseData.episode_id}/egm`, {
                method: "POST",
                body: egmFormData
            });

            if (!episodeResponse.ok) {
                const errorText = await episodeResponse.text();
                console.error("EGM upload failed:", episodeResponse.status, errorText);
                throw new Error(`EGM upload failed: ${episodeResponse.status} - ${errorText}`);
            }

            const egmData = await episodeResponse.json();
            console.log("Response data from upload_episode/egm:", egmData);

            // Combinez les données des labels avec les résultats de la requête IA
            return {
                labels,
                ai_clients: egmData.ai_clients || [],
                jobs: egmData.jobs || []
            };
        }
    } catch (error) {
        console.error("Error processing episode:", error);
        throw error;
    }
}

function closeOverlay() {
    const closeButton = document.querySelector("body > div.ui-dialog.ui-corner-all.ui-widget.ui-widget-content.ui-front > div.ui-dialog-titlebar.ui-corner-all.ui-widget-header.ui-helper-clearfix > button");
    if (closeButton) {
        closeButton.click();
    }
    const overlayContainer = document.querySelector("#overlay-container");
    if (overlayContainer) {
        overlayContainer.style.display = "none";
        overlayContainer.innerHTML = "";
    }
}

async function getSVGBlob() {
    const objectElement = document.querySelector('object[type="image/svg+xml"]');
    
    if (!objectElement || !objectElement.data) {
        console.error("❌ Aucun objet SVG trouvé !");
        return null;
    }

    try {
        const response = await fetch(objectElement.data); // Télécharger le SVG
        if (!response.ok) {
            throw new Error(`Erreur HTTP: ${response.status}`);
        }
        return await response.blob(); // Convertir en Blob
    } catch (error) {
        console.error("❌ Erreur lors de la récupération du SVG :", error);
        return null;
    }
}