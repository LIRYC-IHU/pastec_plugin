import * as pdfjsLib from "pdfjs-dist";
import * as pdflib from "pdf-lib";

import { sendDataToBackground, getEpisodeInformation, loadJsonFile, convertDurationToSeconds, blobToBase64, extractTextByPage, injectGenericHTML, processViewerEpisode, loadPdfAndExtractImages, downloadImageBitmapAsImage, encryptPatientData} from "./content";

const diagnoses = await loadJsonFile("Medtronic");

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');
// Scraping data from the medtronic API

console.log("medtronic script initialized");

const currentUrl = window.location.href;
const transmissionId = currentUrl.split('/')[6];

chrome.runtime.onMessage.addListener(async(message, sender, sendResponse) => {
    if (message.type === "pdfUrl") {
        const requestId = message.requestId;
        const bearer = message.token;
        const implantModel = document.querySelector(".patient-card__detail-line.vt-patient-card-device-brand-name").textContent;
        console.log(implantModel);
        console.log("requestId reçu:", requestId);
        console.log("bearer reçu: ", bearer);

        // let choices = await getChoices(patientData);


        // Récupérer le PDF en tant que Blob
        const pdfBlob = await getPdfByRequestId(requestId, bearer);
        console.log("Blob récupéré", pdfBlob);
        
        try {
            const blobUrl = URL.createObjectURL(pdfBlob);
            // Charger le PDF avec PDF.js en utilisant l'URL du blob
            const pdfDocument = await pdfjsLib.getDocument(blobUrl).promise
            console.log("PDF chargé avec succès", pdfDocument);
            const textArray = await extractTextByPage(pdfDocument);
            console.log("texte récupéré dans le pdf: ", textArray); 
            let metadata = await getMetadataFromText(textArray[0], implantModel);
            console.log("les données récupérées sont les suivantes: ", metadata);

            const [ choices , isAnnotated ] = await getEpisodeInformation(metadata);

            if(!choices) {
                console.error("no choices in api for this episode, trying backup json...")
                choices = diagnoses[metadata.episodeType];
                isAnnotated = false;
            }

            await injectGenericHTML('pdf-viewer');
            await processMedtronicPdf(metadata, blobUrl, choices, isAnnotated);

            const images = await loadPdfAndExtractImages(blobUrl, "medtronic");
            const imagesArray = await downloadImageBitmapAsImage(images, "medtronic");
            console.log(imagesArray);
            
            if (!metadata.diagnosis) {
                console.log (`no diagnosis entered for this episode`);
            } 
            const response = await sendDataToBackground({files: imagesArray, metadata: metadata, isAnnotated: isAnnotated});
            if (response.status === "success") {
                console.log(response.message);
            } else {
                console.error(response.message, ": ", response.error);
            }        
        }catch(error) {
            console.error("Erreur lors du chargement du PDF avec PDF.js", error);
        }
    }
});

async function getPdfByRequestId (requestId, bearerToken) {
    try {
        const response = await fetch(`https://api-nl-prod.medtroniccarelink.net/CareLink.API.Service/api/documents/${requestId}`, {
            method: "GET",
            cache: "no-cache",
            redirect: "follow",
            headers: {
                "Authorization": `Bearer ${bearerToken}`
            }
        });
        if(!response.ok) {
            throw new Error(`error encountered fetching the pdf file: ${response.status}`);
        } else {
            const blob = await response.blob();
            return blob;
        }
    } catch(error) {
        console.error("error occured: ", error);
    }
}

async function getPatientData(transmissionUrl, bearerToken) {
    console.log("document correctly loaded");
    try {
        const transmissionInfo = await fetch(transmissionUrl, {
            method: "GET",
            cache: "no-cache",
            redirect: "follow",
            headers: {
                "Authorization": `Bearer ${bearerToken}`
            }
        });

        if(!transmissionInfo.ok) {
            throw new Error(`an error occurred", ${transmissionInfo.status}`);
        }
        return transmissionInfo.json();
    } catch (error) {
        console.error("an error occurred:", error);
    }
}

async function getMetadataFromText(text, implantModel){

    // expresions régulières variables selon le type d'appareil

    let metadata = {};
    const episodeTypeReg = /^(.*?)(?=\s+Episode)/g;
    const episodeDurationReg = /((\d{1,2}:)?(:\d{1,2})?(:\d{2}))/g;
    const episodeTypeRegCobalt = /(?<=Épisode )(.*?)(?=\s+#\d)/g;
    const implantSerialReg = /(?<=Numéro de série : )([A-Z0-9]+)/g;
    const episodeDateReg = /(\d{2}-[A-Z][a-z]{2}-\d{4})\s+(\d{2}:\d{2})/g; 
    const episodeDateRegCobalt = /(\d{2}-[a-z|A-Z]{3}.-\d{4})\s+(\d{2}:\d{2})/g;

    if(implantModel.trim() === "Cobalt™ VR" || implantModel.trim() === "Cobalt™ DR" || implantModel.trim() === "Cobalt™ XT HF CRT-D") {
        metadata = {
            patientName: document.querySelector("body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div:nth-child(1) > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > div.mdt-flex-col > div > div > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong").textContent,
            implantModel: implantModel.trim(),
            implantSerial: text.match(implantSerialReg)?.[0],
            episodeType: text.match(episodeTypeRegCobalt)?.[0],
            episodeDate: text.match(episodeDateRegCobalt)?.[1],
            url: window.location.href,
            system: "Medtronic"
        }
    } else {

        console.log(text.match(episodeDurationReg)?.[2]);
        metadata = {
            patientName: document.querySelector("body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div:nth-child(1) > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > div.mdt-flex-col > div > div > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong").textContent,
            implantModel: implantModel.trim(),
            implantSerial: text.match(implantSerialReg)?.[0],
            episodeDuration: convertDurationToSeconds(text.match(episodeDurationReg)?.[2], "Medtronic"),
            episodeType: text.match(episodeTypeReg)?.[0],
            episodeDate: text.match(episodeDateReg)?.[1],
            url: window.location.href,
            system: "Medtronic"
        }
    }
    await encryptPatientData(metadata);

    console.log("metadata after encryption is: ", metadata);

    return metadata;
}

async function processMedtronicPdf(dataObject, blobUrl, choices, isAnnotated) {
    console.log('sending pdf blob to iframe');
    if(blobUrl) {
        document.querySelector("#iframe").src = blobUrl;
        console.log("affichage du pdf dans l'iframe");
        dataObject = await processViewerEpisode(dataObject, choices, isAnnotated, blobUrl);
        console.log(dataObject);
        document.querySelector("#pdf-viewer").style.display = "none";
        console.log("PDF correctement traité");
    }
}