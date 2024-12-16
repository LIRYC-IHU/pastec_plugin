import { injectGenericHTML, processViewerEpisode, convertDurationToSeconds } from "./content";
import { authenticatedFetch } from "./auth";
import { ageAtEpisode } from "./data_formatting";

console.log('boston_scraping.js script initialized...');
let batchProcessing = false;

window.addEventListener("load", async () => {
    try {
        console.log("Window loaded, starting script...");
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
            console.log("Showing confirmation dialog");
            const userResponse = window.confirm("Voulez-vous commencer l'analyse de tous les tracés?");
            if (userResponse) {
                console.log("Starting batch processing");
                batchProcessing = true;
                await setupListeners(dataTable);
            } else {
                console.log("Batch processing cancelled by user");
                await setupListeners(dataTable);
            }
        }, 100);

    } catch (error) {
        console.error("Error in main script execution:", error);
    }
});

document.addEventListener("close_overlay", () => closeOverlay());

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
                    await handleEpisodeClick(metadata, true);
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
    
    if (batchProcessing) {
        const egmLinks = document.querySelectorAll(".trueEgmIcon");
        console.log(`Found ${egmLinks.length} EGM links to process`);
        
        for (const [index, link] of egmLinks.entries()) {
            console.log(`Processing episode ${index + 1} of ${egmLinks.length}`);
            await handleBatchAnalysis(link, dataTable, false);
        }
    }
}

async function handleEpisodeClick(metadata, isUserClick = true) {
    try {
        await injectGenericHTML('overlay-container');

        const observer = new MutationObserver(async (mutationsList, observer) => {
            const svgElement = document.querySelectorAll("#egmSvgObjectGraph");
            if (svgElement) {
                observer.disconnect();
                const episodeResponse = await processEpisode(metadata);
                await processViewerEpisode(metadata, episodeResponse.labels, episodeResponse.jobs, episodeResponse.annotated);
                closeOverlay();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Ne déclencher le clic que si ce n'est pas déjà un clic utilisateur
        if (!isUserClick) {
            metadata.selector.click();
        }

    } catch (error) {
        console.error("Error processing episode on click:", error);
    }
}

async function handleBatchAnalysis(link, dataTable, isUserClick = false) {
    return new Promise(async (resolve) => {
        const metadata = dataTable.find(md => md.selector === link);

        if (metadata) {
            await injectGenericHTML('overlay-container');
            console.log("HTML injected for overlay");

            const observer = new MutationObserver(async (mutationsList, observer) => {
                const svgObject = document.querySelector("#events_detail_EgmGraph #egmSvgObjectGraph");
                if (svgObject) {
                    observer.disconnect();
                    
                    try {
                        const svgUrl = svgObject.getAttribute('data');
                        console.log("SVG URL found:", svgUrl);
                        
                        // Faire une requête pour obtenir le contenu SVG
                        const response = await fetch(svgUrl);
                        const svgContent = await response.text();
                        
                        if (!svgContent) {
                            console.error("SVG content missing");
                            throw new Error("Failed to get SVG content");
                        }
                        
                        const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
                        
                        // Créer l'épisode et récupérer les labels
                        const episodeResponse = await processEpisode(metadata, svgBlob);
                        console.log("Episode created with response:", episodeResponse);
                        
                        if (!episodeResponse || !episodeResponse.labels) {
                            console.error("No labels received from server");
                            throw new Error("No labels received from server");
                        }
                        
                        const token = localStorage.getItem("token");
                        await processViewerEpisode(metadata, episodeResponse.labels, episodeResponse.jobs, episodeResponse.annotated);
                        
                        closeOverlay();
                        console.log("Episode processed properly");
                        resolve();
                    } catch (error) {
                        console.error("Error processing SVG:", error);
                        resolve();
                    }
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            // Ne déclencher le clic que si ce n'est pas déjà un clic utilisateur
            if (!isUserClick) {
                link.click();
            }
        } else {
            resolve();
        }
    });
}

async function processEpisode(metadata, files) {
    console.log("Processing viewer episode...");
    
    try {
        const formData = new FormData();
        formData.append("patient_id", metadata.patientId);
        formData.append("manufacturer", metadata.system.toLowerCase());
        formData.append("episode_type", metadata.episodeType);
        formData.append("age_at_episode", ageAtEpisode(metadata.episodeDate, metadata.birthdate) || 0);
        formData.append("episode_duration", metadata.duration.toString());
        formData.append("episode_id", metadata.episodeId);

        const response = await authenticatedFetch("http://127.0.0.1:8000/episode/upload_episode", {
            method: "POST",
            body: formData
        });

        const responseData = await response.json();
        console.log("Response data:", responseData);

        if (!responseData.exists) {
            const egmFormData = new FormData();
            egmFormData.append("file", new Blob([files], {type: 'image/svg+xml'}), 'egm.svg');
            
            await authenticatedFetch(`http://127.0.0.1:8000/episode/${responseData.episode_id}/egm`, {
                method: "POST",
                body: egmFormData
            });
        }

        return responseData;
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
