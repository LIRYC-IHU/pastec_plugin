import { injectGenericHTML, processViewerEpisode, fetchPdfAsBlob, blobToBase64, loadPdfAndExtractImages, downloadImageBitmapAsImage, loadJsonFile, getChoices } from "./content";

const diagnoses = await loadJsonFile("Abbott");

const url = window.location.href;
console.log(url);

const searchParams = new URLSearchParams(url);
const pageType = searchParams.get('reportType');

document.addEventListener("DOMContentLoaded", async() => {

    if(pageType != "EPD") {
        console.log("Episodes page not detected, script not activated");
        return;
    }

    const patientName =  (document.querySelector("#pb-PatientName > span").textContent).replace(/\t|\n/g, '');
    const implantModel = document.querySelector("#pb-PatientId > span:nth-child(3)").textContent;
    const implantSerial = document.querySelector("#pb-PatientId > span:nth-child(1)").textContent; //actually a patientId but serial is not included in the webpage
    const content_table = document.querySelectorAll("#example > tbody > tr");

    let dataTable = [];
    let data_cells;

    content_table.forEach((row) => {
        data_cells = row.querySelectorAll("td");
        const episodeDate = data_cells[0].innerText;
        const episodeType = data_cells[1].innerText;
        let patientId, episodeId;

        let link = data_cells[5].innerHTML.replace(/\t|\n|/g, '');
        link = link.replace(/\s\s+/g, ' ');

        chrome.runtime.sendMessage({
            action: "encrypt patient data",
            episode_info: {episodeDate, patientName, implantSerial}
        }, (response) => {
            const { patientId, episodeId } = response;
            console.log("Received patientId:", patientId);
            console.log("Received episodeId:", episodeId);
        });

        const metadata = {
            patientId: patientId,
            episodeId: episodeId,
            implantModel: implantModel,
            episodeDate: episodeDate,
            episodeType: episodeType,
            system: "Abbott",
            link: link
        }
        dataTable.push(metadata);
    });
    await overlaySetup(dataTable, diagnoses);
    await setupListenersAbbott(dataTable, diagnoses);
    //Une fois les données récupérées, itérer sur l'affichage des différents pdf après prompt utilisateur
});

async function clickLinkFromInnerHTML(htmlString) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlString;
        const linkElement = tempDiv.querySelector('a');
        document.body.appendChild(tempDiv);
        linkElement.click();
        document.body.removeChild(tempDiv);
}

async function setupListenersAbbott (dataTable, diagnoses) {
    document.querySelector('#example').addEventListener('click', async(event) => {
        const target = event.currentTarget;
        const child = event.target.firstChild;
        console.log("child: ", child);
        console.log("target", target);
    })

}

async function overlaySetup(dataTable, diagnoses) {
    if(window.confirm("Commencer l'analyse?")){
        await injectGenericHTML('overlay-container');
        await processEpisode(dataTable, diagnoses);
    }
}

async function processEpisode(dataTable, diagnoses) {

    for (const metadata of dataTable){
        console.log("interating through pdf episodes");
        console.log(metadata.link);

        if(!metadata.link.trim().startsWith("<a href")){ //skips ocurrences without EGM
            console.log(`no EGM for episode`);
            continue;
        }

        await clickLinkFromInnerHTML(metadata.link);
        const choices = diagnoses[metadata.episodeType];
        const isAnnotated = false;
        console.log("diagnostic choices: ", choices);
/*         let choices = await getChoices(metadata);  for implementation when api works */
        if(choices){
            await processViewerEpisode(metadata, choices, isAnnotated);
        } else console.log("no diagnoses defined for episode: ", metadata.episodeType);

        const pdfElement = (document.querySelector("#pdfFrame"));
        console.log(pdfElement);
        const pdfLink = pdfElement.getAttribute('src');
        const pdfBlob = await fetchPdfAsBlob('https://www.merlin.net' + pdfLink);
        const pdfUrl = URL.createObjectURL(pdfBlob);

        const images = await loadPdfAndExtractImages(pdfUrl, 'abbott');
        const imagesArray = await downloadImageBitmapAsImage(images);

        URL.revokeObjectURL(pdfUrl);
        delete metadata.link;

        const dataObject = {
            files: imagesArray,
            metadata: metadata
        }

        console.log(dataObject);
        await chrome.storage.local.set({"dataObject": dataObject});  
        if(!metadata.diagnosis){
            console.log("no diagnosis selected, sending the pdf without annotation");
        }  
    }


    window.alert("Tous les épisodes ont été traités");
    (document.querySelector("#overlay-container")).style.display = 'none';
    (document.querySelector("body > div.ui-dialog.ui-widget.ui-widget-content.ui-corner-all.ui-draggable > div.ui-dialog-titlebar.ui-widget-header.ui-corner-all.ui-helper-clearfix > div > a.ui-dialog-titlebar-close.ui-corner-all")).click();
}
