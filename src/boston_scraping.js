import { injectGenericHTML, processViewerEpisode, convertDurationToSeconds } from "./content";
import { authenticatedFetch, authenticateUser} from "./auth";
import { ageAtEpisode } from "./data_formatting";

console.log('boston_scraping.js script initialized...');

console.log("API URL:", process.env.API_URL);
const API_URL = process.env.API_URL;

let isBatch = false;
let labels = [];


window.addEventListener("load", async () => {
    try {
        document.addEventListener("close_overlay", () => closeOverlay());
        document.addEventListener("stop_batch", () => isBatch = false);
        console.log("Window loaded, starting script...");
        const access_token = await authenticateUser();

        // getting all the labels for the manufacturer to improve reactiveness
        const allLabelsResponse = await authenticatedFetch(`${API_URL}/episode/diagnoses_labels/Boston`);
        const allLabels = await allLabelsResponse.json();
        labels = allLabels.labels;
        console.log("Labels extracted:", labels);


        const patientNameElement = document.querySelector("#postage_name");
        const deviceElement = document.querySelector("#postage_device");
        const dobElement = document.querySelector('#postage_dob');

        if (!patientNameElement || !deviceElement || !dobElement) {
            console.error("Required elements not found on page");
            return;
        }

        const patientName = patientNameElement.textContent;
        const [implantModel, implantSerial] = deviceElement.textContent.split("/");
        const content_table = document.querySelectorAll("#episode > tbody > tr");
        const birthdate = dobElement.textContent;

        console.log("Patient info collected:", {
            patientName,
            implantModel,
            implantSerial,
            birthdate,
            rowCount: content_table.length
        });

        let dataTable = [];

        for (const row of content_table) {
            const data_cells = row.querySelectorAll("td");
            if (data_cells.length === 0) continue;

            let episodeDate = data_cells[2]?.innerText;
            if (!episodeDate) continue;

            const [date, time] = episodeDate.split(' ');

            console.log("Encrypting data for episode:", episodeDate);
            const encryptResponse = await chrome.runtime.sendMessage({
                action: "encrypt patient data",
                episode_info: {
                    patient_id: patientName,
                    system: "Boston",
                    episode_type: data_cells[3]?.innerText,
                    date: date,
                    time: time
                }
            });

            const metadata = {
                patientName,
                implantSerial,
                implantModel,
                episodeDate,
                birthdate,
                episodeType: data_cells[3]?.innerText,
                duration: data_cells[5]?.innerText,
                system: "Boston",
                selector: data_cells[1]?.querySelector(".trueEgmIcon"),
                patientId: encryptResponse?.patientId,
                episodeId: encryptResponse?.episodeId
            };

            if (metadata.selector) {
                dataTable.push(metadata);
                console.log("Added episode to dataTable:", episodeDate);
            }
        }

        console.log("DataTable prepared:", dataTable.length, "episodes");

        setTimeout(async () => {
            console.log("setting up the listeners...");
            await setupListeners(dataTable);
            console.log("Showing confirmation dialog");
            const episodeResponse = window.confirm("Voulez-vous commencer l'analyse de tous les tracés?");
            if (episodeResponse) {
                isBatch = true;
                // getting all the links to the EGMs
                const egmLinks = document.querySelectorAll(".trueEgmIcon");
                console.log("Starting batch processing");
                handleBatchAnalysis(egmLinks, dataTable);
            } else {
                isBatch = false;
                console.log("Batch processing cancelled by user");
            }
        }, 100);

    } catch (error) {
        console.error("Error in main script execution:", error);
    }
});



async function setupListeners(dataTable) {
    console.log("Setting up listeners");

    const episodeElement = document.querySelector("#episode");
    if (!episodeElement) {
        console.error("Episode table not found");
        return;
    }
    console.log("Adding click listener to episode table");
    episodeElement.addEventListener('click', async (event) => {
        const target = event.target;
        console.log("Click detected on:", target);
        
        if (target.matches('.trueEgmIcon')) {
            console.log("Click on EGM icon detected");
            
            // Debug des métadonnées
            const metadata = dataTable.find(md => {
                console.log("Comparing:", md.selector, target);
                return md.selector === target;
            });
            
            if (metadata) {
                console.log("Metadata found:", metadata);
                try {
                    await handleEpisodeClick(metadata, isBatch);
                } catch (error) {
                    console.error("Error in handleEpisodeClick:", error);
                }
            } else {
                console.error("No metadata found for clicked element");
            }
        } else {
            console.log("Click not on EGM icon");
        }
    });
}

async function handleEpisodeClick(metadata, isBatch) {
    return new Promise(async(resolve) => {
        try {
            console.log("isBatch:", isBatch);
            console.log("Handling episode click:", metadata);
            console.log("injecting overlay");
            // 1) Injecter l'overlay
            await injectGenericHTML("overlay-container");
            // 2) Préparer un observer pour capter l'insertion du SVG
            const observer = new MutationObserver(async () => {
                const svgObject = document.querySelector("#events_detail_EgmGraph #egmSvgObjectGraph");
                if (svgObject) {
                    observer.disconnect();
                    try {
                        console.log("SVG object found:", svgObject);
                        const svgUrl = svgObject.getAttribute("data");
                        console.log("SVG URL found:", svgUrl);

                        const response = await fetch(svgUrl);
                        if (!response.ok) {
                            throw new Error(`Erreur de récupération du SVG: ${response.status}`);
                        }

                        const svgContent = await response.text();
                        if (!svgContent) {
                            throw new Error("Le contenu SVG est vide.");
                        }

                        // Créer un Blob
                        const svgBlob = new Blob([svgContent], { type: "image/svg+xml" });
                        // 3) Upload + process
                        const uploadPromise = processEpisode(metadata, svgBlob);
                        console.log("Episode created:", uploadPromise);

                        await processViewerEpisode(metadata, labels[metadata.episodeType], uploadPromise);
                        console.log("Episode processed successfully (handleEpisodeClick).");
                        if(!isBatch){
                            const event = new Event("close_overlay");
                            document.dispatchEvent(event);
                        }
                        resolve();
                    } catch (error) {
                        console.error("Erreur lors du traitement du SVG:", error);
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

        } catch (error) {
            console.error("Erreur lors du traitement de l'épisode:", error);
        }

    });
}

async function handleBatchAnalysis(egmLinks, dataTable, isBatch) {
    console.log("Starting batch analysis...");

    for (let i = 0; i < egmLinks.length; i++) {
        console.log("egm links number:", egmLinks.length);
        const link = egmLinks[i];
        link.click();
        console.log(`Link n°${i+1}:`, link);

        // Récupérer la metadata associée
        const metadata = dataTable.find(md => md.selector === link);
        if (!metadata) {
            console.warn("No metadata found for this link, skipping...");
            continue;
        }

        await handleEpisodeClick(metadata, isBatch);
        
        // Une fois fini, on passe au suivant
        console.log(`Episode ${i+1} OK, next...`);

        if(i === egmLinks.length - 1) {
            console.log("All episodes processed.");
            batchProcessing = false;
            const event = new Event("close_overlay");
            const stopBatch = new Event("stop_batch");
            document.dispatchEvent(event);
            document.dispatchEvent(stopBatch);
        }

    }

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log("Batch processing complete.");
}

async function processEpisode(metadata, files) {
    console.log("Processing viewer episode...");
    
    try {
        const formData = new FormData();
        formData.append("patient_id", metadata.patientId);
        formData.append("manufacturer", metadata.system.toLowerCase());
        formData.append("implant_model", metadata.implantModel);
        formData.append("episode_type", metadata.episodeType);
        formData.append("age_at_episode", ageAtEpisode(metadata.episodeDate, metadata.birthdate) || 0);
        formData.append("episode_duration", metadata.duration.toString());
        formData.append("episode_id", metadata.episodeId);

        // Étape 1 : Appel à `upload_episode`
        console.log("Uploading episode metadata...");
        const response = await authenticatedFetch(`${API_URL}/episode/upload_episode`, {
            method: "POST",
            body: formData
        });

        const responseData = await response.json();
        console.log("Response data from upload_episode:", responseData);
        console.log('responsedata.exists:', responseData.exists);


        // Labels disponibles dans `responseData`
        const labels = responseData.labels;

        // Étape 2 : Vérifiez si l'épisode existe et si l'EGM est uploadé
        if (responseData.exists && responseData.egm_uploaded) {
            // L'épisode existe avec EGM, récupérez directement les modèles IA et les jobs
            console.log("Episode exists with EGM uploaded. Using response data...");
            return {
                annotated: responseData.annotated,
                exists: responseData.exists,
                egm_uploaded: true,
                ai_clients: responseData.ai_clients || [],
                jobs: responseData.jobs || []
            };
        } else {
            // L'épisode n'existe pas ou EGM pas uploadé, procédez à l'upload de l'EGM
            console.log("Episode does not exist or EGM not uploaded. Proceeding to upload EGM...");
            const egmFormData = new FormData();
            egmFormData.append("files", new Blob([files], { type: 'image/svg+xml' }), 'egm.svg');

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
                annotated: responseData.annotated,
                exists: responseData.exists,
                egm_uploaded: true,
                ai_clients: egmData.ai_clients || [],
                jobs: egmData.jobs || []
            };
        }
    } catch (error) {
        console.error("Error processing episode:", error);
        throw error;
    }
}

async function closeOverlay() {
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