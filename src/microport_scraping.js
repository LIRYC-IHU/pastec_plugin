// Scraping for Microport: few info inside the webpage, need to scrape the pdf like in Medtronic to get the information.
import * as pdfjsLib from "pdfjs-dist";
import { extractTextByPage, processViewerEpisode, fetchPdfAsBlob, blobToBase64, base64ToBlob, loadPdfAndExtractImages, downloadImageBitmapAsImage, getChoices, injectGenericHTML, loadJsonFile } from "./content"

console.log("microport_scraping.js initialized...");

const diagnoses = await loadJsonFile("Microport");

document.addEventListener("DOMContentLoaded", async () => {
    try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');
        
        // Assurez-vous que le sélecteur correspond exactement à ce que vous attendez et qu'il est présent dans le DOM
        const pdfFrame = document.querySelector("#ctl00_CphBody_TabContainer_TabPanelDetail_PatientTransmissionDetailsUc_PdfTabContainer_TabPanelEgmPdf_EgmPdfFrameEmbedded");
        
        if (!pdfFrame) {
            console.error("PDF iframe not found.");
            return;
        }
        
        const pdfPath = pdfFrame.src;

        const pdfBlob = await fetchPdfAsBlob(pdfPath);
        const blobUrl = URL.createObjectURL(pdfBlob);

        console.log("PDF processing...");
        const pdfDocument = await pdfjsLib.getDocument(blobUrl).promise;
        const textArray = await extractTextByPage(pdfDocument); 
        const base64 = await blobToBase64(pdfBlob);

        await chrome.storage.local.set({pdfData: {base64, textArray}});

        await chrome.runtime.sendMessage("pdfData sent", async(response) => {
            console.log(response);
            const result = await chrome.storage.local.get('pdfMetadataArray');
            const metadata = result.pdfMetadataArray;
            const isAnnotated = false; 

            if(window.confirm("Récupération du PDF réalisée, voulez-vous commencer l'analyse?")) {
                await injectGenericHTML('pdf-viewer');
                await processEachPDFSequentially(metadata, diagnoses);
                await chrome.runtime.sendMessage("pdf treated");
                }
        });
    } catch (error) {
        console.error("An error occurred:", error);
    }
});

async function processEachPDFSequentially(metadata, diagnoses, currentIndex = 0) {
    if (currentIndex >= metadata.length) {
        window.alert("All PDFs have been processed.");
        document.querySelector('#pdf-viewer').style.display = "none";
        return;
    }

    const fileKey = `file_${currentIndex}`;
    console.log("The file key is ", fileKey);

    // Using local storage consistently
    const fileResult = await new Promise(resolve => chrome.storage.local.get(fileKey, resolve));
    console.log(fileResult);
    const pdfData = fileResult[fileKey];

    if (pdfData) {
        console.log("Decoding pdfData...");
        const pdfBlob = base64ToBlob(pdfData);
        const pdfUrl = URL.createObjectURL(pdfBlob);
        document.querySelector('#iframe').src = pdfUrl;
        console.log(`Displaying PDF ${currentIndex} in the iframe.`);
        console.log("metadata of the current index is ", metadata[currentIndex]);

        const choices = diagnoses[metadata[currentIndex].episodeType];

        console.log("metadata: ", metadata);
        console.log("choices: ", choices);


        const isAnnotated = false;

        // Wait for user interaction with the contextual buttons
        metadata[currentIndex] = await processViewerEpisode(metadata[currentIndex], choices, isAnnotated);
        console.log("Processing images...");

        const images = await loadPdfAndExtractImages(pdfUrl, "microport");
        const imagesArray = await downloadImageBitmapAsImage(images);

        console.log("Images processed, sending data to background");

        chrome.runtime.sendMessage({
            action: "send dataObject to background",
            dataObject: {files: imagesArray, metadata: metadata[currentIndex]}
        }, response => {
            if (response) {
                console.log("Background response:", response);
            } else {
                console.error("Failed to send message to background or no response received");
            }
        });
        await processEachPDFSequentially(metadata, diagnoses, currentIndex + 1);
    } else {
        console.error(`PDF data undefined for ${fileKey}.`);
        // Optionally skip to the next index or handle the error differently
        await processEachPDFSequentially(metadata, diagnoses, currentIndex + 1);
    }
}