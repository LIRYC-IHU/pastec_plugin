import * as pdfjsLib from "pdfjs-dist";

import { sendDataToBackground, getEpisodeInformation, convertDurationToSeconds, extractTextByPage, injectGenericHTML, processViewerEpisode, loadPdfAndExtractImages, bitmapsToBase64} from "./content";
import { authenticatedFetch } from "./auth";
import { ageAtEpisode } from "./data_formatting";
import "./intercept-fetch";

console.log("medtronic_scraping.js loaded");
console.log("API URL:", process.env.API_URL);
const API_URL = process.env.API_URL;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');

const allLabelsResponse = await authenticatedFetch(`${API_URL}/episode/diagnoses_labels/Medtronic`);
const diagnoses = await allLabelsResponse.json();

console.log("medtronic script initialized");

console.log("labels: ", diagnoses)

const currentUrl = window.location.href;
const transmissionId = currentUrl.split('/')[6];

let interceptedPdfBlob = null;

window.addEventListener("PASTEC_PDF_BLOB", async (event) => {
    const { url, blob } = event.detail;
    console.log("PDF Blob reçu:", url);
    interceptedPdfBlob = blob;
    
    // Extract request ID from URL for processing
    const requestIdMatch = url.match(/\/api\/documents\/(\d+)$/);
    if (requestIdMatch) {
        const requestId = requestIdMatch[1];
        console.log("RequestId extracted from intercepted URL:", requestId);
        
        // Process the PDF immediately using the intercepted blob
        await processPdfFromBlob(requestId, blob);
    }
});

async function processPdfFromBlob(requestId, pdfBlob) {
    const implantModel = document.querySelector(".patient-card__detail-line.vt-patient-card-device-brand-name").textContent;
    console.log(implantModel);
    console.log("Processing PDF from intercepted blob, requestId:", requestId);
    
    try {
        const blobUrl = URL.createObjectURL(pdfBlob);
        // Charger le PDF avec PDF.js en utilisant l'URL du blob
        const pdfDocument = await pdfjsLib.getDocument(blobUrl).promise
        console.log("PDF chargé avec succès", pdfDocument);
        const textArray = await extractTextByPage(pdfDocument);
        console.log("texte récupéré dans le pdf: ", textArray); 
        let metadata = await getMetadataFromText(textArray[0], implantModel);
        console.log("les données récupérées sont les suivantes: ", metadata);

        const choices = diagnoses.labels[metadata.episodeType]
        console.log(choices)

        // uploading the episode
        const responseData = await processEpisode(metadata, pdfBlob, blobUrl);

        await injectGenericHTML('pdf-viewer');
        await processMedtronicPdf(metadata, blobUrl, choices, responseData);

        console.log("Episode processed successfully");

        if (!metadata.diagnosis) {
            console.log (`no diagnosis entered for this episode`);
        } 

        console.log("sending data to backend...");
        
    } catch(error) {
        console.error("Erreur lors du chargement du PDF avec PDF.js", error);
    }
}

chrome.runtime.onMessage.addListener(async(message, sender, sendResponse) => {
    if (message.type === "pdfUrl") {
        const requestId = message.requestId;
        console.log("pdfUrl message received, requestId:", requestId);
        
        // Check if we already have the intercepted blob for this request
        if (interceptedPdfBlob) {
            console.log("Using intercepted PDF blob");
            await processPdfFromBlob(requestId, interceptedPdfBlob);
            interceptedPdfBlob = null; // Clear after use
        } else {
            console.log("No intercepted blob available, falling back to fetch");
            const bearer = message.token;
            const pdfBlob = await getPdfByRequestId(requestId, bearer);
            await processPdfFromBlob(requestId, pdfBlob);
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
    console.log("=== getMetadataFromText DEBUG START ===");
    console.log("Input text:", text?.substring(0, 500) + "..."); // First 500 chars
    console.log("Input implantModel:", implantModel);

    // expresions régulières variables selon le type d'appareil
    let metadata = {};
    const episodeTypeReg = /^(.*?)(?=\s+Episode)/g;
    const episodeDurationReg = /((\d{1,2}:)?(:\d{1,2})?(:\d{2}))/g;
    const episodeTypeRegCobalt = /(?<=Épisode )(.*?)(?=\s+#\d)/g;
    const implantSerialReg = /(?<=Numéro de série : )([A-Z0-9]+)/g;
    const episodeDateReg = /(\d{2}-[A-Z][a-z]{2}-\d{4})\s+(\d{2}:\d{2})/g; 
    const episodeDateRegCobalt = /(\d{2}-[a-z|A-Z]{3}.-\d{4})\s+(\d{2}:\d{2})/g;

    // Helper function to safely get DOM element text
    function safeQuerySelector(selector, description) {
        try {
            const element = document.querySelector(selector);
            if (!element) {
                console.warn(`❌ DOM element not found for ${description}:`, selector);
                return null;
            }
            console.log(`✅ Found ${description}:`, element.textContent);
            return element;
        } catch (error) {
            console.error(`❌ Error querying ${description}:`, error, selector);
            return null;
        }
    }

    // Helper function to safely match regex
    function safeRegexMatch(text, regex, index, description) {
        try {
            const match = text.match(regex);
            console.log(`Regex match for ${description}:`, match);
            const result = match?.[index];
            if (!result) {
                console.warn(`❌ No match found for ${description}`);
            } else {
                console.log(`✅ Found ${description}:`, result);
            }
            return result;
        } catch (error) {
            console.error(`❌ Error matching ${description}:`, error);
            return null;
        }
    }

    // Helper function to extract episode date with multiple patterns and fallbacks
    function extractEpisodeDate(text, isCobalt) {
        console.log("--- Attempting to extract episode date ---");
        
        // Multiple date patterns to try
        const datePatterns = [
            // Original patterns
            { regex: /(\d{2}-[A-Z][a-z]{2}-\d{4})\s+(\d{2}:\d{2})/g, index: 1, name: "standard date format" },
            { regex: /(\d{2}-[a-z|A-Z]{3}.-\d{4})\s+(\d{2}:\d{2})/g, index: 1, name: "cobalt date format" },
            
            // Additional patterns for table data
            { regex: /(\d{2}-[A-Za-z]{3}-\d{4})/g, index: 0, name: "simple date format" },
            { regex: /(\d{1,2}\/\d{1,2}\/\d{4})/g, index: 0, name: "slash date format" },
            { regex: /(\d{2}-[A-Za-z]{3,9}-\d{4})/g, index: 0, name: "extended month format" },
            
            // Date patterns from table content
            { regex: /Date\s+(\d{2}-[A-Za-z]{3}-\d{4})/gi, index: 1, name: "table date with label" },
            { regex: /(\d{2}-[A-Za-z]{3,9}-\d{4})\s+\d{2}:\d{2}/g, index: 1, name: "date with time" }
        ];

        for (const pattern of datePatterns) {
            const result = safeRegexMatch(text, pattern.regex, pattern.index, pattern.name);
            if (result) {
                console.log(`✅ Successfully extracted date using ${pattern.name}: ${result}`);
                return result;
            }
        }

        // If no date found, try to get current date from webpage
        console.warn("❌ Could not extract episode date from PDF text, trying webpage...");
        
        try {
            const dateElement = document.querySelector('[class*="date"], [class*="Date"], .transmission-date, .episode-date');
            if (dateElement && dateElement.textContent) {
                console.log(`✅ Found date from webpage: ${dateElement.textContent}`);
                return dateElement.textContent.trim();
            }
        } catch (error) {
            console.error("Error extracting date from webpage:", error);
        }

        // Final fallback - use current date
        const fallbackDate = new Date().toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        }).replace(/ /g, '-');
        
        console.warn(`❌ Using fallback date: ${fallbackDate}`);
        return fallbackDate;
    }

    const isCobaltModel = implantModel.trim() === "Cobalt™ VR" || 
                         implantModel.trim() === "Cobalt™ DR" || 
                         implantModel.trim() === "Cobalt™ XT HF CRT-D";
    
    console.log("Is Cobalt model:", isCobaltModel);

    try {
        if (isCobaltModel) {
            console.log("--- Processing Cobalt model ---");
            
            // Get patient name - try multiple selectors
            let patientNameElement = safeQuerySelector(
                "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong",
                "patient name (Cobalt - primary selector)"
            );
            
            // Fallback selector if primary fails
            if (!patientNameElement) {
                patientNameElement = safeQuerySelector(
                    "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div:nth-child(1) > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > div.mdt-flex-col > div > div > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong",
                    "patient name (Cobalt - fallback selector)"
                );
            }
            
            // Get birthdate
            const birthdateElement = safeQuerySelector(
                "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > cws-patient-card > div > div.patient-card__content > div > div:nth-child(1) > div.patient-card__detail-line.vt-patient-date-of-birth",
                "birthdate (Cobalt)"
            );
            
            let birthdate = null;
            if (birthdateElement?.textContent) {
                try {
                    const birthdateParts = birthdateElement.textContent.split(" ");
                    console.log("Birthdate parts:", birthdateParts);
                    birthdate = birthdateParts[1];
                    console.log("Extracted birthdate:", birthdate);
                } catch (error) {
                    console.error("❌ Error processing birthdate:", error);
                }
            }

            metadata = {
                patientName: patientNameElement?.textContent || "UNKNOWN",
                implantModel: implantModel.trim(),
                birthdate: birthdate || "UNKNOWN",
                implantSerial: safeRegexMatch(text, implantSerialReg, 0, "implant serial (Cobalt)"),
                episodeDuration: convertDurationToSeconds(safeRegexMatch(text, episodeDurationReg, 2, "episode duration (Cobalt)"), "Medtronic"),
                episodeType: safeRegexMatch(text, episodeTypeRegCobalt, 0, "episode type (Cobalt)"),
                episodeDate: extractEpisodeDate(text, true),
                url: window.location.href,
                system: "Medtronic"
            };
        } else {
            console.log("--- Processing non-Cobalt model ---");
            
            // Get patient name - try multiple selectors
            let patientNameElement = safeQuerySelector(
                "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong",
                "patient name (non-Cobalt - primary selector)"
            );
            
            // Fallback selector if primary fails
            if (!patientNameElement) {
                patientNameElement = safeQuerySelector(
                    "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div:nth-child(1) > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > div.mdt-flex-col > div > div > cws-patient-card > div > div.patient-card__header.row > div.patient-card__name-container > a > div > strong",
                    "patient name (non-Cobalt - fallback selector)"
                );
            }
            
            // Get birthdate
            const birthdateElement = safeQuerySelector(
                "body > cws-root > div > ui-carelink-shell > ui-main-shell > mat-sidenav-container > mat-sidenav-content > div > cws-transmission-dashboard > div > div > cws-transmission-detail-dashboard > div > div.dashboard-header-blocks-container > cws-patient-card > div > div.patient-card__content > div > div:nth-child(1) > div.patient-card__detail-line.vt-patient-date-of-birth",
                "birthdate (non-Cobalt)"
            );
            
            let birthdate = null;
            if (birthdateElement?.textContent) {
                try {
                    const birthdateParts = birthdateElement.textContent.split(" ");
                    console.log("Birthdate parts:", birthdateParts);
                    birthdate = birthdateParts[1];
                    console.log("Extracted birthdate:", birthdate);
                } catch (error) {
                    console.error("❌ Error processing birthdate:", error);
                }
            }

            const episodeDurationMatch = safeRegexMatch(text, episodeDurationReg, 2, "episode duration (non-Cobalt)");
            console.log("Episode duration match result:", episodeDurationMatch);

            metadata = {
                patientName: patientNameElement?.textContent || "UNKNOWN",
                implantModel: implantModel.trim(),
                birthdate: birthdate || "UNKNOWN",
                implantSerial: safeRegexMatch(text, implantSerialReg, 0, "implant serial (non-Cobalt)"),
                episodeDuration: convertDurationToSeconds(episodeDurationMatch, "Medtronic"),
                episodeType: safeRegexMatch(text, episodeTypeReg, 0, "episode type (non-Cobalt)"),
                episodeDate: extractEpisodeDate(text, false),
                url: window.location.href,
                system: "Medtronic"
            };
        }

        console.log("Final metadata object:", metadata);
        console.log("=== Metadata extraction completed ===");

    } catch (error) {
        console.error("❌ Critical error in getMetadataFromText:", error);
        console.error("Stack trace:", error.stack);
        throw error;
    }

    const encryptResponse = await chrome.runtime.sendMessage({
        action: "encrypt patient data",
        episode_info: {
            patient_id: metadata.implantSerial,
            system: metadata.system,
            episode_type: metadata.episodeType,
            date: metadata.episodeDate,
            time: metadata.episodeDuration.toString()
        }
    });

    console.log("encrypt response: ", encryptResponse)

    metadata.patientId= encryptResponse?.patientId;
    metadata.episodeId= encryptResponse?.episodeId;

    console.log("metadata after encryption is: ", metadata);

    return metadata;
}

async function convertBitmapsToPngFiles(bitmapArray) {
    console.log("Converting", bitmapArray.length, "images to PNG files");
    const files = [];
    
    for (let i = 0; i < bitmapArray.length; i++) {
        const imageObj = bitmapArray[i];
        console.log(`Processing image ${i}:`, imageObj.width, 'x', imageObj.height);
        
        // Create a canvas to convert the bitmap to PNG
        const canvas = document.createElement('canvas');
        canvas.width = imageObj.width;
        canvas.height = imageObj.height;
        const ctx = canvas.getContext('2d');
        
        // The bitmap property contains the actual ImageBitmap
        if (imageObj.bitmap) {
            ctx.drawImage(imageObj.bitmap, 0, 0);
        } else {
            console.error(`No bitmap property found for image ${i}`);
            throw new Error(`Image ${i} missing bitmap property`);
        }
        
        // Convert canvas to blob
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, 'image/png');
        });
        
        if (!blob) {
            throw new Error(`Failed to create PNG blob for image ${i}`);
        }
        
        console.log(`✅ Converted image ${i} to PNG:`, blob.size, 'bytes');
        
        // Create a File object from the blob
        const file = new File([blob], `egm_image_${i}.png`, { type: 'image/png' });
        files.push(file);
    }
    
    console.log(`Successfully converted ${files.length} images to PNG files`);
    return files;
}

async function processMedtronicPdf(metadata, blobUrl, choices, responseData) {
    console.log('=== Setting up Medtronic PDF viewer ===');
    console.log('Metadata:', metadata);
    console.log('Choices for episode type:', choices);
    console.log('Response data:', responseData);
    
    try {
        // 1. Set PDF in iframe
        const iframe = document.querySelector("#iframe");
        if (!iframe) {
            throw new Error("Iframe not found in overlay");
        }
        
        iframe.src = blobUrl;
        console.log("✅ PDF loaded in iframe");
        
        // 2. Show the pdf-viewer overlay
        const pdfViewer = document.querySelector("#pdf-viewer");
        if (!pdfViewer) {
            throw new Error("PDF viewer overlay not found");
        }
        
        pdfViewer.style.display = "flex";
        console.log("✅ PDF viewer overlay displayed");
        
        // 3. Populate diagnostic buttons with episode-specific labels
        const buttonContainer = document.querySelector(".popup-label-buttons");
        if (!buttonContainer) {
            throw new Error("Button container not found");
        }
        
        // Clear existing buttons
        buttonContainer.innerHTML = "";
        
        if (choices && choices.length > 0) {
            console.log(`Creating ${choices.length} diagnostic buttons`);
            
            choices.forEach((choice, index) => {
                const button = document.createElement("button");
                button.className = "label-button";
                button.textContent = choice;
                button.dataset.label = choice;
                button.dataset.index = index;
                
                // Add click handler for diagnosis selection
                button.addEventListener('click', () => {
                    console.log(`Diagnostic selected: ${choice}`);
                    handleDiagnosisSelection(choice, metadata);
                });
                
                buttonContainer.appendChild(button);
                console.log(`✅ Added button: ${choice}`);
            });
        } else {
            console.warn("No diagnostic choices available for this episode type");
            buttonContainer.innerHTML = '<p class="no-choices">Aucun diagnostic disponible pour ce type d\'épisode</p>';
        }
        
        // 4. Set up AI annotations display and check job status
        const aiFieldValue = document.querySelector(".ai-field-value");
        if (aiFieldValue) {
            if (responseData.annotated) {
                aiFieldValue.innerHTML = '<span class="annotated">✅ Épisode déjà annoté</span>';
            } else {
                aiFieldValue.innerHTML = '<span class="pending">⏳ En attente d\'analyse IA</span>';
            }
        }
        
        // 5. Check AI job status from the upload response
        checkMedtronicJobStatus(responseData);
        
        // 5. Set up close button
        const closeButton = document.querySelector("#close-container .gg-close-o");
        if (closeButton) {
            closeButton.addEventListener('click', () => {
                console.log("Closing PDF viewer");
                closePdfViewer();
            });
        }
        
        // 6. Set up skip button
        const skipButton = document.querySelector("#skip");
        if (skipButton) {
            skipButton.addEventListener('click', () => {
                console.log("Skipping analysis");
                closePdfViewer();
            });
        }
        
        console.log("✅ Medtronic PDF viewer setup completed");
        
    } catch (error) {
        console.error("❌ Error setting up PDF viewer:", error);
        throw error;
    }
}

async function handleDiagnosisSelection(diagnosis, metadata) {
    console.log(`Handling diagnosis selection: ${diagnosis}`);
    console.log('Episode metadata:', metadata);
    
    try {
        // Verify that the episode ID exists
        if (!metadata.episodeId) {
            throw new Error("Episode ID is missing from metadata");
        }
        
        console.log("Sending annotation for episode:", metadata.episodeId);
        console.log("Label:", diagnosis);

        const response = await authenticatedFetch(`${API_URL}/episode/${metadata.episodeId}/annotation`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                label: diagnosis
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error("Annotation error details:", errorData);
            throw new Error(`Error adding annotation: ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const annotationResult = await response.json();
        console.log("Annotation added successfully:", annotationResult);
        
    } catch (error) {
        console.error("Error processing annotation:", error);
        // Don't close viewer on error to allow retry
        return;
    }
    
    closePdfViewer();
}

async function checkMedtronicJobStatus(responseData) {
    const aiSelector = document.querySelector(".ai-field-value");
    
    try {
        console.log("Checking AI job status with response data:", responseData);
        
        // Check if AI is available for this episode type
        if (!responseData.ai_available) {
            console.log("❌ Pas d'analyse IA disponible pour ce type d'épisode");
            aiSelector.innerHTML = "❌ Pas d'analyse IA en cours";
            return;
        }
        
        const { ai_clients, jobs } = responseData;
        
        if (!jobs || jobs.length === 0) {
            console.log("✅ Aucun job IA en attente, résolution immédiate.");
            aiSelector.innerHTML = "✅ Aucun travail IA en attente.";
            return;
        }

        console.log(`🔄 Vérification de ${jobs.length} jobs en cours...`);

        const fetchJobData = async (job) => {
            try {
                const response = await authenticatedFetch(`${API_URL}/ai/jobs?job_id=${job}`, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json"
                    }
                });
                return await response.json();
            } catch (error) {
                console.error("❌ Échec de la récupération du job:", error);
                return null;
            }
        };

        const updateJobElements = async () => {
            let remainingJobs = [...jobs];
            const job_number = jobs.length;
            const startTime = Date.now();
            let aiResults = {};
        
            while (remainingJobs.length > 0) {
                // Check timeout (10 seconds)
                if (Date.now() - startTime >= 10000) { 
                    console.warn("⏳ Timeout atteint (10s) : Arrêt des requêtes IA.");
                    aiSelector.innerHTML = "⏳ Temps d'attente dépassé. Vérifiez les résultats manuellement.";
                    break;
                }
        
                let completedCount = 0;

                // Check job status
                for (const job of remainingJobs) {
                    const data = await fetchJobData(job);
                    if (data && data.status === "completed") {
                        completedCount++;
                        console.log(`✅ Job ${job} terminé.`);
                        aiResults[data.id_model] = data.job_annotation;
                    }
                }
        
                const pendingCount = job_number - completedCount;
                aiSelector.innerHTML = `${pendingCount} travaux IA en cours...`;

                if (pendingCount === 0) {
                    // Display results if AI toggle is enabled and jobs are completed
                    const aiCheck = await chrome.storage.local.get("aiCheck");
                    console.log("AI check status:", aiCheck);
                    if (aiCheck.aiCheck) {
                        console.log("AI check is enabled, displaying results");
                        aiSelector.innerHTML = "✅ Tous les travaux IA sont terminés";
                        for (const [model, result] of Object.entries(aiResults)) {
                            const resultDiv = document.createElement("div");
                            resultDiv.className = "ai-result";
                            resultDiv.innerHTML = `<strong>${model}:</strong> ${result}`;
                            aiSelector.appendChild(resultDiv);
                        }
                    } else {
                        console.log("AI check is disabled, not displaying results");
                        aiSelector.innerHTML = "✅ Tous les travaux IA sont terminés";
                    }

                    break;
                }
        
                // Pause before next check
                await new Promise(resolve => setTimeout(resolve, 1000)); 
            }
        };

        await updateJobElements();
    } catch (error) {
        console.error("⚠️ Erreur dans checkMedtronicJobStatus:", error);
        aiSelector.innerHTML = "❌ Erreur lors de la vérification des jobs IA";
    }   
}

function closePdfViewer() {
    // Always remove the outermost container created by injectGenericHTML
    const pdfViewerContainer = document.getElementById("pdf-viewer");
    if (pdfViewerContainer) {
        // Find the parent if this element is nested inside another pdf-viewer container
        let containerToRemove = pdfViewerContainer;
        if (pdfViewerContainer.parentElement && pdfViewerContainer.parentElement.id === "pdf-viewer") {
            containerToRemove = pdfViewerContainer.parentElement;
        }
        
        containerToRemove.remove();
        console.log("PDF viewer removed from DOM");
    }
} 

async function processEpisode(metadata, pdfBlob, blobUrl) {
    console.log("Processing viewer episode...");

    try {
        const formData = new FormData();
        formData.append("patient_id", metadata.patientId);
        formData.append("manufacturer", metadata.system.toLowerCase());
        formData.append("episode_type", metadata.episodeType);
        formData.append("implant_model", metadata.implantModel);
        formData.append("age_at_episode", ageAtEpisode(metadata.episodeDate, metadata.birthdate, "medtronic") || 0);
        formData.append("episode_duration", metadata.episodeDuration.toString());
        formData.append("episode_id", metadata.episodeId);

        console.log("FormData prepared for upload:", formData
            , "\nPatient ID:", metadata.patientId,
            "\nManufacturer:", metadata.system.toLowerCase(),
            "\nEpisode Type:", metadata.episodeType,
            "\nImplant Model:", metadata.implantModel,
            "\nAge at Episode:", ageAtEpisode(metadata.episodeDate, metadata.birthdate, "medtronic") || 0,
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
        }

        console.log("Episode does not exist or EGM not uploaded. Proceeding with EGM upload...");
        const imagesArray = await loadPdfAndExtractImages(blobUrl, "medtronic");
        console.log("Images extracted from PDF:", imagesArray);

        console.log(typeof(imagesArray[0]));

        // Convert bitmap images to PNG files properly
        const pngFiles = await convertBitmapsToPngFiles(imagesArray);
        console.log("PNG files created:", pngFiles.length);

        const multipartFormData = new FormData();
        pngFiles.forEach((file, index) => {
            multipartFormData.append(`files`, file, `egm_image_${index}.png`);
        });
        console.log("FormData created with PNG files:", multipartFormData);

        let episodeResponse;
        if (!responseData.exists || !responseData.egm_uploaded) {
            console.log("Episode is new or EGM not uploaded, proceeding with EGM upload...");
            episodeResponse = await authenticatedFetch(`${API_URL}/episode/${responseData.episode_id}/egm`, {
                method: "POST",
                body: multipartFormData
            });
        }

        if (episodeResponse && !episodeResponse.ok) {
            const errorText = await episodeResponse.text();
            console.error("EGM upload failed:", episodeResponse.status, errorText);
            throw new Error(`EGM upload failed: ${episodeResponse.status} - ${errorText}`);
        } else if (episodeResponse) {
            console.log("EGM upload successful");
            console.log("Response status:", episodeResponse.status);

            const egmData = await episodeResponse.json();
            console.log("Response data from upload_episode/egm:", egmData);

            // Combinez les données des labels avec les résultats de la requête IA
            return {
                labels,
                ai_clients: egmData.ai_clients || [],
                jobs: egmData.jobs || [],
                exists: false,
                annotated: false
            };
        } else {
            // Episode existed, return basic data
            return {
                labels,
                ai_clients: [],
                jobs: [],
                exists: true,
                annotated: responseData.annotated
            };
        }
    } catch (error) {
        console.error("Error processing episode:", error);
        throw error;
    }
}