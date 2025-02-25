import * as pdfjsLib from "pdfjs-dist";
import { authenticatedFetch } from "./auth";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.js');

const API_URL = process.env.API_URL;

export function cleanAllButtons() {
    const buttons = document.querySelectorAll(".label-button");
    buttons.forEach(button => {
        button.remove(); // Simpler and more readable way to remove an element
    });
}

export async function extractTextByPage(PDFDocumentLoadingTask) {
    const textPages = []; //array contenant le texte par page de chaque pdf

    for (let i = 1; i <= PDFDocumentLoadingTask.numPages; i++) { //itération sur toutes les pages du pdf
        const page = await PDFDocumentLoadingTask.getPage(i);
        const textContent = await page.getTextContent();
        const textItems = textContent.items.map(item =>item.str).join(' ');
        textPages.push(textItems);
    }

    return textPages;
}

export async function fetchPdfAsBlob(url) {
    const response = await fetch(url);
    return await response.blob();
}

export async function injectGenericHTML(containerId) {
    try {
        // Vérifier si le conteneur existe déjà
        let container = document.getElementById(containerId);
        
        // Si le conteneur n'existe pas, le créer
        if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            document.body.appendChild(container);
        }

        // Charger et injecter le HTML
        const response = await fetch(chrome.runtime.getURL(`html/${containerId}.html`));
        const data = await response.text();
        container.innerHTML = data;

        console.log(`Container ${containerId} created/updated successfully`);
        return container;
    } catch (err) {
        console.error('Error in injectGenericHTML:', err);
        throw new Error(`Failed to inject HTML: ${err.message}`);
    }
}

export function resetOverlayContainer() {
    const container = document.getElementById('overlay-container');
    if (container) {
        container.innerHTML = '';
    }
}

export async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Extraire la partie base64 de la Data URL
            const base64data = reader.result.split(',')[1];
            resolve(base64data);
        };
        reader.onerror = () => {
            reject(new Error("Erreur lors de la conversion du blob en base64."));
        };
        reader.readAsDataURL(blob);
    });
}

export function base64ToBlob(base64, type = 'application/pdf') {
    // Séparer la chaîne base64 du préfixe Data URL, s'il existe
    const base64Data = base64.split(',')[1] ? base64.split(',')[1] : base64;

    try {
        // Décoder la chaîne base64 pour obtenir une chaîne binaire
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);

        // Convertir la chaîne binaire en un tableau d'octets
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Créer et retourner un objet Blob à partir de l'array d'octets
        return new Blob([bytes], { type: type });
    } catch (e) {
        console.error("Erreur lors de la conversion de base64 en Blob:", e);
        return null; // Retourner null ou gérer l'erreur d'une autre manière
    }
}

export async function uint8ArrayToBase64(uint8Array) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64 = reader.result.split(',')[1]; // Enlever le préfixe Data URL
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export async function processViewerEpisode(metadata, labels, uploadPromise) {
    const pdf_viewer = document.querySelector(".popup-label-buttons");
    pdf_viewer.innerHTML = "";

    console.log("Metadata in processViewerEpisode:", metadata);
    console.log("Labels in processViewerEpisode:", labels);
    console.log("uploadPromise in processViewerEpisode:", uploadPromise); 

    if (!pdf_viewer) {
        console.error("Popup container not found.");
        throw new Error("Popup container not found.");
    }

    checkJobStatus(uploadPromise);

    const aiSelector = document.querySelector(".ai-field-value");

    return new Promise(async (resolve, reject) => {
    // populate the overlay with the buttons
        console.log("Diagnostic choices:", labels);
        labels.forEach((diag, index) => {
        const labelButton = document.createElement('button');
        labelButton.className = "label-button";
        labelButton.textContent = `${index + 1} - ${diag}`;
        pdf_viewer.appendChild(labelButton);

        labelButton.addEventListener('click', async () => {
            try {       
                const { exists, ai_clients, jobs } = await uploadPromise;  
                
                console.log("exists:", exists);
                console.log("ai_clients", ai_clients);
                console.log("jobs", jobs);
                // Vérifier que l'ID de l'épisode existe
                if (!metadata.episodeId) {
                    throw new Error("Episode ID is missing from metadata");
                }
                
                console.log("Sending annotation for episode:", metadata.episodeId);
                console.log("Label:", diag);

                const response = await authenticatedFetch(`${API_URL}/episode/${metadata.episodeId}/annotation`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        label: diag
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    console.error("Annotation error details:", errorData);
                    throw new Error(`Error adding annotation: ${response.statusText} - ${JSON.stringify(errorData)}`);
                }

                const annotationResult = await response.json();
                console.log("Annotation added successfully:", annotationResult);
                console.log("is annotated", exists);

                // Continuer avec le reste du traitement
                if (exists) {
                    if (window.confirm(`L'épisode en cours d'analyse est déjà annoté dans la base de données ; confirmer la nouvelle entrée?`)) {
                        await processDiagnosis(diag, metadata);
                        console.log("resolving episode already in database")
                        resolve(metadata);
                    } else {
                        console.log("episode already in database, resolving without annotation")
                        resolve(metadata);
                    }
                } else {
                    await processDiagnosis(diag, metadata);
                    console.log("resolving episode not in database")
                    resolve(metadata);
                }

                cleanAllButtons();
                document.querySelector("#option-1").checked = false;
                document.querySelector("#option-2").checked = true;
            } catch (error) {
                console.error("Error processing annotation:", error);
                reject(error);
            }
        });
        });

    addListenersToPopup("overlay-container");

        // Bouton pour passer l'épisode
        const skipButton = document.querySelector("#skip");
        skipButton.addEventListener('click', () => {
            console.log("Skip button clicked");
            cleanAllButtons();
            document.querySelector("#option-1").checked = false;
            document.querySelector("#option-2").checked = true;
            console.log("resolving skip button")
            resolve(metadata);
        });

        // Fonction pour traiter un diagnostic
        async function processDiagnosis(diagnosis, data) {
            console.log("Processing diagnosis:", diagnosis);
            data.diagnosis = diagnosis;
            data.isAlert = document.querySelector("#option-1").checked;
            console.log("Alert status:", data.isAlert);
        }

        // Raccourcis clavier pour sélectionner un diagnostic avec les touches numériques
        const key_map = [49, 50, 51, 52, 53, 54, 55, 56, 57, 58];
        document.onkeydown = (e) => {
            const keyCode = e.keyCode;
            const buttons = document.querySelectorAll(".label-button");
            const buttonIndex = key_map.indexOf(keyCode);
            console.log("Key pressed, button index:", buttonIndex);
            if (buttonIndex >= 0 && buttonIndex < buttons.length) {
                buttons[buttonIndex].click();
            }
        };
    });

    console.log("End of processViewerEpisode, auto-resolving promise");
}

async function checkJobStatus(uploadPromise) {

    const aiSelector = document.querySelector(".ai-field-value");

    try {
        uploadPromise.then(async ({ ai_client, jobs }) => {
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
                    console.error("Failed to fetch job data:", error);
                    return null;
                }
            };
    
            const updateJobElements = async () => {
                let remainingJobs = [...jobs];  // Copie des jobs pour éviter de modifier l'original
                const job_number = jobs.length;
                const startTime = Date.now();   // Stocker le temps de début
            
                while (remainingJobs.length > 0) {
                    // Vérifier si le timeout de 10 secondes est atteint
                    if (Date.now() - startTime >= 10000) { 
                        console.warn("⏳ Timeout atteint (10s) : Arrêt des requêtes IA.");
                        aiSelector.innerHTML = "⏳ Temps d'attente dépassé. Vérifiez les résultats manuellement.";
                        break;  // Arrêter la boucle
                    }
            
                    let completedCount = 0;
            
                    for (const job of remainingJobs) {
                        const data = await fetchJobData(job);
            
                        if (data && data.status === "completed") {
                            completedCount++;
                        }
                    }
            
                    const pendingCount = job_number - completedCount;
                    aiSelector.innerHTML = `${pendingCount} travaux IA en cours`;
            
                    if (pendingCount === 0) {
                        aiSelector.innerHTML = "✅ Tous les travaux IA sont terminés";
                        break;  // Arrêter la boucle
                    }
            
                    await new Promise(resolve => setTimeout(() => {
                        console.log("resolving in job check")
                        resolve();
                    }, 1000)); // Pause avant le prochain check
                }
            };
            await updateJobElements();
        });
    } catch(error) {
        console.error("Error in checkJobStatus:", error);
        throw new Error("Failed to check job status");
    }   
}

export async function loadPdfAndExtractImages(pdfBlob, system) {
    const images = [];
    const pdfDoc = await pdfjsLib.getDocument(pdfBlob).promise;

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const ops = await page.getOperatorList();
        const args = ops.argsArray;
        const fns = ops.fnArray;
        let filenumber = 1;

        let imgsFound = 0;
        for (let i = 0; i < fns.length; i++) {
            // Vérifier si l'opération est paintJpegXObject
            if (fns[i] === pdfjsLib.OPS.paintImageXObject) {
                const imgKey = args[i][0]; // Clé de l'image dans objs
                imgsFound++;
                // console.log(`Image #${imgsFound} trouvée sur la page ${pageNum}`);
                const imgObj = page.objs.get(imgKey);
                if (imgObj.width == 2670 && system == "microport"){ //largeur des fichier EGM et du tachogramme
                    images.push(imgObj);
                }
                if (system == "abbott") images.push(imgObj);
                if (imgObj.width == 720 && system == "medtronic") images.push(imgObj);
            }
        }
    }

    return images;
}

export async function downloadImageBitmapAsImage(imageBitmapArray, system) {
    const base64ImageArray = [];

    for (const [index, imageBitmap] of imageBitmapArray.entries()) {
        // Création d'un nouveau canvas pour chaque image
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = imageBitmap.width;
        canvas.height = imageBitmap.height;

        // Dessin de l'image bitmap sur le canvas
        ctx.drawImage(imageBitmap.bitmap, 0, 0);

        // Application de rectangles blancs selon le système
        if (system === "abbott") {
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, 200);  // Rectangle blanc en haut
            const bottomHeight = index === 0 ? 250 : 170;
            ctx.fillRect(0, canvas.height - bottomHeight, canvas.width, bottomHeight);  // Rectangle blanc en bas
        }

        // Conversion du contenu du canvas en base64 pour archivage
        const base64Image = canvas.toDataURL('image/png');
        base64ImageArray.push(base64Image);

        // // Attente de la création du blob et de son téléchargement
        // await new Promise((resolve) => {
        //     canvas.toBlob((blob) => {
        //         if (blob) {
        //             downloadBlob(blob).then(resolve);  // Téléchargement du blob et résolution de la promesse
        //         } else {
        //             console.error('Failed to create blob from canvas');
        //             resolve();  // Résolution de la promesse même en cas d'échec pour continuer le traitement
        //         }
        //     }, 'image/png');
        // });
    }

    return base64ImageArray;
}

function addListenersToPopup(htmlname) {
    const input1 = document.querySelector("#option-1");
    const input2 = document.querySelector("#option-2");
    const close = document.querySelector("#close-container > i");
    const skip = document.querySelector("#skip");

    close.addEventListener('click', () => {
        console.log("close button clicked");
        //créer un custom event "close overlay"
        const closeEvent = new CustomEvent("close_overlay");
        document.dispatchEvent(closeEvent);
    })

    document.body.onkeydown = function (e) {
        let keyCode = e.keyCode;
        console.log(keyCode);
        if(keyCode == '73') {
            input1.click();
        } 
        if(keyCode == '79') {
            input2.click();
        }
        if(keyCode == '48') skip.click();
    };
}

export async function loadJsonFile(url) { 
    const response = await fetch(url);
    return await response.json();
}

export function convertDurationToSeconds(duration, system) {
    let hours = 0, minutes = 0,  seconds = 0;
    let hoursMatch, minutesMatch, secondsMatch;

    console.log("duration: ", duration);

    if(!duration) {
        console.error("no duration in the string");
        return -1;
    }

    switch(system){
        case 'Biotronik':
            const fullPatternB = /(?:(\d+)h)?\s*(?:(\d+)min)?\s*(?:(\d+)s)?/
            if(duration === "---") return 0;
            const matchB = duration.match(fullPatternB);
            if (matchB) {
                hours = parseInt(matchB[1] || 0, 10);
                minutes = parseInt(matchB[2] || 0, 10);
                seconds = parseInt(matchB[3] || 0, 10);
            }
            break;
        case 'Microport':
            const fullPatternM = /(?:(\d+)h)?\s*(?:(\d+)min)?\s*(?:(\d+)s)?/;
            const matchM = duration.match(fullPatternM);
            if (matchM) {
                hours = parseInt(matchM[1] || 0, 10);
                minutes = parseInt(matchM[2] || 0, 10);
                seconds = parseInt(matchM[3] || 0, 10);
            }
            break;
        case 'Medtronic':
            const fullPattern = /(?:(\d{1,2}):)?(?:(\d{1,2}):)?(\d{2})/;
            const match = duration.match(fullPattern);
            if (match) {
                if (match[1] && match[2]) {
                    // hh:mm:ss format
                    hours = parseInt(match[1], 10);
                    minutes = parseInt(match[2], 10);
                    seconds = parseInt(match[3], 10);
                } else if (match[1]) {
                    // mm:ss format
                    minutes = parseInt(match[1], 10);
                    seconds = parseInt(match[2], 10);
                } else {
                    // ss format
                    seconds = parseInt(match[3], 10);
                }
            }
            break;
        case 'Boston':
            if(duration === "--------") return 0;
            else{
                const fullPatternB = /(\d{1,2}):(\d{2}):(\d{2})/;
                const matchB = duration.match(fullPatternB);
                if (matchB) {
                    hours = parseInt(matchB[1], 10);
                    minutes = parseInt(matchB[2], 10);
                    seconds = parseInt(matchB[3], 10);
                }
            }
            break;
    }

    return hours * 3600 + minutes * 60 + seconds;
}

export async function copyAlertsToClipboard() {

    try {
        // Récupérer l'array d'URLs depuis le local storage
        const request = await chrome.storage.local.get("alertArray");
        const urlsArray = request.alertArray;

        if (!urlsArray || urlsArray.length === 0) {
            console.error("No URLs found in local storage.");
            return;
        }
    } catch (error) {
        console.error("Failed to send email with URLs:", error);
        return;
    }

    const text = `Voici les alertes EGM nécessitant d'être revues: \n\n ${urlsArray.join('\n')}`
    navigator.clipboard.writeText(text).then(function() {
        console.log('Text copied to clipboard successfully!');
    }, function(err) {
        console.error('Could not copy text: ', err);
    });

    window.alert("Les alertes en attente on été copiées dans le presse-papiers");
}

export function openMailto(email) {
    const subject = encodeURIComponent("Liste des EGM en attente de revue");
    window.open(`mailto:${email}?subject=${subject}&body=`, '_blank');
}

// functions handling messages to background for API calls

export async function encryptPatientData(data) {
    const encryptResponse = await chrome.runtime.sendMessage({
        action: "encrypt patient data",
        episode_info: {episodeDate: data.episodeDate, patientName: data.patientName, implantSerial: data.implantSerial}
    });

    data.patientId = encryptResponse.patientId;
    data.episodeId = encryptResponse.episodeId;

    return data;
}

export async function getEpisodeInformation(episodeId) {
    console.log("metadata in function", episodeId);
    try {
        const episodeInformation = await chrome.runtime.sendMessage({
            action: "get episode information",
            metadata: episodeId
        });
    
        return [ episodeInformation.response.choices, !episodeInformation.response.Need_EGM ];
    } catch (error) {
        console.error("error getting episode information", error)
    }
}

export async function sendDataToBackground(data) {
    return await chrome.runtime.sendMessage({
        action: "send dataObject to background",
        dataObject: data
    });
}

async function getEpisodeLink(system, blobUrl) {
    switch (system) {
        case "Boston":
            return document.querySelector("#events_detail_reportLink").href;
        case "Microport":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Medtronic":
            return blobUrl;
        case "Biotronik":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Abbott":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        default:
            console.error("error: invalid constructor: ", data.system);
            break;
    }
}

export async function addDiagnosisToEpisode(episodeId, label) {
    try {
        const response = await authenticatedFetch(`${API_URL}/episodes/${encodeURIComponent(episodeId)}/label?label=${encodeURIComponent(label)}`, {
            method: "PUT",
        });

        const responseData = await response.json();

        if (response.ok) {
            console.log("Diagnosis added successfully:", responseData);
            return responseData;
        } else {
            console.error("Error adding diagnosis:", responseData.detail || responseData);
            throw new Error(responseData.detail || "Failed to add diagnosis");
        }
    } catch (error) {
        console.error("Error in addDiagnosisToEpisode:", error);
        throw error;
    }
}

export async function calculateAgeInSeconds(birthdate) {
    const birthDateObj = new Date(birthdate);
    const now = new Date();
    return Math.floor((now - birthDateObj) / 1000);
}