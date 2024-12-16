import { injectGenericHTML, processViewerEpisode, fetchPdfAsBlob, encryptPatientData, getEpisodeInformation, sendDataToBackground, convertDurationToSeconds, loadJsonFile } from "./content";

import { blobToBase64 } from "./data_formatting";

console.log("biotronik_scraping.js script initialized");
const diagnoses = await loadJsonFile('Biotronik');

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
        const patientName = document.querySelector("#DisplayEpisode\\:headerPatientName").textContent;
        const implantSerial = document.querySelector("#DisplayEpisode\\:headerImplantSN").textContent;
        catchPrintButton();

        let metadata = {
            patientName:  patientName,
            implantSerial: implantSerial,
            implantModel: document.querySelector("#DisplayEpisode\\:headerImplantName").textContent,
            episodeDate: document.querySelector("#reportData1 > tbody > tr:nth-child(4) > td.Value").textContent,
            episodeType: document.querySelector("#reportData1 > tbody > tr:nth-child(3) > td.Value").textContent,
            episodeDuration: convertDurationToSeconds(document.querySelector("#reportData1 > tbody > tr:nth-child(6) > td.Value").textContent, "Biotronik"),
            system: 'Biotronik',
            url: window.location.href,
            svg: document.querySelector("#DisplayEpisode > table > tbody > tr:nth-child(2) > td > table > tbody > tr:nth-child(1) > td.RightColumn > table > tbody > tr > td.Content > table.ChartData > tbody > tr:nth-child(2) > td > object").data
        };

        const blob = await fetchPdfAsBlob(metadata.svg);
        const svg_base64 = await blobToBase64(blob);

        await injectGenericHTML('overlay-container');
        await encryptPatientData(metadata);
        const [ choices , isAnnotated ] = await getEpisodeInformation(metadata);

        if (!choices) {
            console.error("No diagnostic choices registered for episodeType ", metadata.episodeType);
        } else {
            await processViewerEpisode(metadata, choices, isAnnotated);
            if (!metadata.diagnosis) {
                console.log (`no diagnosis entered for this episode`);
            } 
            const response = await sendDataToBackground({files: svg_base64, metadata: metadata, isAnnotated: isAnnotated});
            if (response.status === "success") {
                console.log(response.message);
                document.querySelector("#DisplayEpisode\\:displayNextEpisodeTop").click();
            } else {
                console.error(response.message, ": ", response.error);
            }        
        }
    } catch (error) {
        console.error("An error occurred: ", error);
    }

    if(document.querySelector("#DisplayEpisode\\:displayNextEpisodeTop").disabled == true){
        window.alert("tous les épisodes ont été traités");
    };
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