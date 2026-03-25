import { injectGenericHTML, processViewerEpisode, fetchPdfAsBlob, blobToBase64, convertDurationToSeconds, showExtensionError } from "./content";
import { ageAtEpisode } from "./data_formatting";
import { authenticateUser, authenticatedFetch } from "./auth";

console.log("biotronik_scraping.js script initialized");
console.log("API URL:", process.env.API_URL);
const API_URL = process.env.API_URL;

let biotronikInitialized = false;

function findBiotronikEpisodeElement() {
    return (
        document.querySelector("#DisplayEpisode") ||
        document.querySelector("#reportData1") ||
        document.querySelector('object[type="image/svg+xml"]') ||
        document.querySelector("#DisplayEpisode\\:printButton")
    );
}

function bootstrapBiotronikScript() {
    if (biotronikInitialized) {
        return;
    }

    const element = findBiotronikEpisodeElement();
    if (!element) {
        return;
    }

    biotronikInitialized = true;
    initializeScript().catch((error) => {
        console.error("Biotronik bootstrap failed:", error);
        showExtensionError(error, "Erreur Biotronik");
        biotronikInitialized = false;
    });
}

const observer = new MutationObserver(() => {
    bootstrapBiotronikScript();
});

observer.observe(document, {childList: true, subtree: true});
bootstrapBiotronikScript();

async function initializeScript() {
    try {
        console.log("Initializing Biotronik scraping script...");
        const allLabelsResponse = await authenticatedFetch(`${API_URL}/episode/diagnoses_labels/Biotronik`);
        const allLabels = await allLabelsResponse.json();
        const labels = allLabels.labels;    
        console.log("Labels:", labels);
        document.addEventListener("close_overlay", () => closeOverlay());

        console.log("Fetching patient data...");

        // --- 1. Helpers ----------------------------------------------------------------
        const safeText = (selector, label) => {
        const el = document.querySelector(selector);
        if (!el) {
            console.warn(`[Scraper] Élément manquant : ${label} (${selector})`);
            return null;
        }
        return el.textContent?.trim() ?? null;
        };

        const safeData = (selector, label) => {
        const obj = document.querySelector(selector);
        if (!obj) {
            console.warn(`[Scraper] Élément manquant : ${label} (${selector})`);
            return null;
        }
        return obj.data ?? null;
        };

        // --- 2. Collecte ----------------------------------------------------------------
        let scrapedData = {
            patientName    : null,
            birthdate      : null,
            implantSerial  : null,
            implantModel   : null,
            episodeDate    : null,
            episodeType    : null,
            episodeDuration: null,
            system         : 'Biotronik',
            url            : window.location.href,
            svgElement     : null
        };

        try {
            scrapedData.patientName   = safeText("#DisplayEpisode\\:headerPatientName", "patientName");
            scrapedData.implantSerial = safeText("#DisplayEpisode\\:headerImplantSN",    "implantSerial");
            scrapedData.implantModel  = safeText("#DisplayEpisode\\:headerImplantName",  "implantModel");

            scrapedData.episodeDate = safeText(
                "#reportData1 > tbody > tr:nth-child(4) > td.Value",
                "episodeDate"
            );
            scrapedData.episodeType = safeText(
                "#reportData1 > tbody > tr:nth-child(3) > td.Value",
                "episodeType"
            );
              scrapedData.birthdate = safeText(                
                "#DisplayEpisode\\:headerPatientDateOfBirth",
                "birthdate"
            );
            const durationTxt = safeText(
                "#reportData1 > tbody > tr:nth-child(6) > td.Value",
                "episodeDuration(raw)"
            );
            scrapedData.episodeDuration = durationTxt
                ? convertDurationToSeconds(durationTxt, "Biotronik")
                : 0;

            scrapedData.svgElement = safeData(
                "#DisplayEpisode > table > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td.RightColumn > table > tbody > tr > td.Content > table.ChartData > tbody > tr:nth-child(2) > td > object",
                "svgElement"
            );

            // --- 3. Vérification / log ---------------------------------------------------
            const missing = Object.entries(scrapedData)
                                    .filter(([_, v]) => v === null)
                                    .map(([k]) => k);

            if (missing.length) {
                console.error(`[Scraper] Champs non récupérés : ${missing.join(", ")}`);
                showExtensionError(`Certaines données patient sont manquantes : ${missing.join(", ")}`, "Erreur de récupération des données");
                throw new Error("Certaines données patient sont manquantes ; voir la console pour le détail.");
            }

            console.info("[Scraper] Données patient récupérées :", scrapedData);

        } catch (err) {
            console.error("[Scraper] Échec de récupération des données :", err.message);
            console.debug("[Scraper] État partiel :", scrapedData);
            // Propager si besoin
            throw err;
        }





        catchPrintButton();

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

        if (!encryptResponse?.patientId || !encryptResponse?.episodeId) {
            console.error("Invalid encryption response for Biotronik episode:", encryptResponse);
            throw new Error("Unable to generate encrypted identifiers for this episode");
        }

        const metadata = {
            patientName: scrapedData.patientName,
            implantSerial: scrapedData.implantSerial,
            implantModel: scrapedData.implantModel,
            episodeDate: scrapedData.episodeDate,
            birthdate: scrapedData.birthdate,
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
            showExtensionError(error, "Erreur lors du traitement de l'épisode");
        }       
    } catch (error) {
        console.error("An error occurred: ", error);
        showExtensionError(error, "Erreur Biotronik");
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
    showExtensionError(error, "Erreur lors de l'ouverture du PDF");
}

}

async function processEpisode(metadata) {
    console.log("Processing viewer episode...");
    
    try {
        const formData = new FormData();
        formData.append("patient_id", metadata.patientId);
        formData.append("manufacturer", metadata.system.toLowerCase());
        formData.append("episode_type", metadata.episodeType);
        formData.append("implant_model", metadata.implantModel);
        formData.append("age_at_episode", ageAtEpisode(metadata.episodeDate, metadata.birthdate) || 0);
        formData.append("episode_duration", metadata.episodeDuration.toString());
        formData.append("episode_id", metadata.episodeId);

        console.log("FormData prepared for upload:", formData
            , "\nPatient ID:", metadata.patientId,
            "\nManufacturer:", metadata.system.toLowerCase(),
            "\nEpisode Type:", metadata.episodeType,
            "\nImplant Model:", metadata.implantModel,
            "\nAge at Episode:", ageAtEpisode(metadata.episodeDate, metadata.birthdate) || 0,
            "\nEpisode Duration:", metadata.episodeDuration.toString(),
            "\nEpisode ID:", metadata.episodeId
        );

        // Étape 1 : Appel à `upload_episode`
        console.log("Uploading episode metadata...");
        const response = await authenticatedFetch(`${API_URL}/episode/upload_episode`, {
            method: "POST",
            body: formData
        });

        const responseData = await response.json();
        console.log("Response data from upload_episode:", responseData);
        console.log("responsedata annotation", responseData.annotated);

        if (responseData?.episode_id) {
            metadata.episodeId = responseData.episode_id;
        }
        if (responseData?.patient_id) {
            metadata.patientId = responseData.patient_id;
        }

        // Labels disponibles dans `responseData`
        const labels = responseData.labels;

        // Étape 2 : Vérifiez si l'épisode existe et si l'EGM est uploadé
        if (responseData.exists && responseData.egm_uploaded) {
            // L'épisode existe avec EGM, récupérez directement les modèles IA et les jobs
            console.log("Episode exists with EGM uploaded. Using response data...");
            return {
                labels,
                ai_clients: responseData.ai_clients || [],
                jobs: responseData.jobs || [],
                exists: true,
                annotated: responseData.annotated,
                egm_uploaded: true
            };
        } else {
            console.log("Episode does not exist or EGM not uploaded. Proceeding with SVG upload...");
            const svgBlob = await getSVGBlob();
            if (!svgBlob) {
                console.error("❌ Impossible de récupérer le SVG en Blob.");
                return;
            }
        
            // Vérification
            console.log("🎯 Taille du fichier SVG (Blob) :", svgBlob.size, "octets");
        
            // Préparer FormData
            const egmFormData = new FormData();
            egmFormData.append("files", svgBlob, "egm.svg");
            
            // Debug: Vérifier le contenu de FormData
            console.log("📊 FormData entries:");
            for (let [key, value] of egmFormData.entries()) {
                console.log(`${key}:`, value);
                if (value instanceof File || value instanceof Blob) {
                    console.log(`  - Size: ${value.size} bytes`);
                    console.log(`  - Type: ${value.type}`);
                    console.log(`  - Name: ${value.name || 'unnamed'}`);
                }
            }

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
                jobs: egmData.jobs || [],
                exists: false,
                annotated: false,
                egm_uploaded: true
            };
        }
    } catch (error) {
        console.error("Error processing episode:", error);
        showExtensionError(error, "Erreur lors de l'envoi de l'épisode");
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
        console.log("🔍 Elements trouvés avec 'object':", document.querySelectorAll('object'));
        return null;
    }

    console.log("✅ SVG object trouvé, URL:", objectElement.data);

    try {
        console.log("🌐 Fetching SVG from:", objectElement.data);
        const response = await fetch(objectElement.data); // Télécharger le SVG
        if (!response.ok) {
            throw new Error(`Erreur HTTP: ${response.status}`);
        }
        console.log("✅ SVG fetch successful, Content-Type:", response.headers.get('content-type'));
        const blob = await response.blob(); // Convertir en Blob
        console.log("📦 Blob créé - Size:", blob.size, "Type:", blob.type);
        return blob;
    } catch (error) {
        console.error("❌ Erreur lors de la récupération du SVG :", error);
        showExtensionError(error, "Erreur lors de la récupération de l'EGM");
        return null;
    }
}
