import * as pdflib from "pdf-lib";
import * as CryptoJS from "crypto-js";
import * as JSZip from "jszip";
import { uint8ArrayToBase64, convertDurationToSeconds } from "./content";

let bearerToken;
const processedRequestIds = new Set();

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL || details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
        console.log("Extension installed or updated");
    }
});

// background.js
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  console.log("✋ rule matched!", info);
});

// (optional) inspect which rulesets are enabled
chrome.declarativeNetRequest.getEnabledRulesets(sets => {
  console.log("Enabled rulesets:", sets);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "encrypt patient data") {
        console.log("Encrypting patient data in the background");
        encryptData(message.episode_info).then(({ patientId, episodeId }) => {;
            console.log("Patient ID:", patientId);
            console.log("Episode ID:", episodeId);
            sendResponse({ patientId: patientId, episodeId: episodeId });
        }).catch((error) => {
            console.error("Error encrypting patient data: ", error);
            sendResponse({ status: "error", message: "Failed to encrypt patient data", error: error.message || error.toString() });
        });
        return true; // Indicate that the response will be sent asynchronously
    }
    if(message.action === "get episode diagnosis") {
        console.log("get episode diagnosis message received");
        getAnnotation(message.metadata).then((response) => {
            console.log(response);
            sendResponse({
                status: 'success',
                message: 'episode diagnosis correctly fetched',
                response: response
            })
        }).catch(error => {
            console.error ("error getting episode diagnosis: ", error);
        })
        return true;
    }
    if(message.action === "get episode information") {
        handleEpisodeInfo(message.metadata).then((response) => {
            console.log("response from API get episode info", response);
            sendResponse({
                status: "success",
                message: "episode information fetched successfully",
                response: response
            })
        }).catch(error => {
            console.error("error processing episode information: ", error )
            sendResponse({
                status:"error",
                message: "failed to process episode information: ",
                error: error.message || error.toString()
            });
        });
        return true;
    }
    if(message.action === "send dataObject to background") {
        handlePdfTreated(message).then(() => {
            sendResponse({status: "success", message: "Object sent to server successfully"});
        }).catch(error => {
            console.error("error processing the data object: ", error);
            sendResponse({
                status: "error", 
                message: "Failed to process the data object", 
                error: error.message || error.toString()});
        });
        return true;
    }
    if(message.action === "handle alert printing") {
        console.log("handling alert printing: ", message.message);
        handleAlertPrinting(message.message). then(() => {
        }).catch(error => {
            console.error("error printing the episode: ", error);
            });
        return true;
    }          
    if (message == "pdfData sent") {
        console.log("message received from content script");
        chrome.storage.local.get('pdfData')
            .then(data => {
                const { pdfData: { base64, textArray} } = data;
                return getDataFromPdf(textArray)
                    .then(pdfMetadataArray => {
                        return getEpisodeLength(textArray)
                            .then(lengthArray => {
                                splitPdfByEpisodes(base64, lengthArray)
                                    .then(() => {
                                        chrome.storage.local.set({pdfMetadataArray}).then(() => {
                                            sendResponse({status: "success", message: "pdf treated successfully"});
                                        })
                                    });
                            });
                    });
            })  
            .catch(error => {
                console.error(error);
            });
            return true;
    }
    if(message.action === "get cookies") {
        chrome.cookies.getAll({url: message.url}).then(response => {
            sendResponse(response)
        }).catch(error => {
            console.error ("error getting the cookies; ", error)
        });
        return true;
    }
});

chrome.webRequest.onBeforeSendHeaders.addListener(
    async function(details) {
    if(bearerToken == undefined) {
        console.log("header intercepté");
        const headers = details.requestHeaders;
        for (const header of headers) {
          if (header.name.toLowerCase() === "authorization" && header.value.startsWith("bearer ")) {
            bearerToken = header.value.split(" ")[1]; // Extrait le token Bearer
            console.log("Bearer Token intercepté:", bearerToken);
          }
        }
    }
    },
    { urls: ["https://api-nl-prod.medtroniccarelink.net/CareLink.API.Service/api/transmissions/*"] },
    ["requestHeaders"]
  );

chrome.webRequest.onHeadersReceived.addListener(
    async function(details) {
        const urlRequete = new URL(details.url);
        const components = urlRequete.pathname.split('/');
        const documentID = components.pop()
        const pattern = /\d+/ 

        if (details.method === "GET" && pattern.test(documentID) && !processedRequestIds.has(documentID)) {
            processedRequestIds.add(documentID);
            console.log("Requête API interceptée:", details.url);
            console.log("Code réponse: ", details.statusCode);
            chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                const activeTab = tabs[0];
                if (activeTab) {
                    console.log("request link being sent to content script")
                    chrome.tabs.sendMessage(activeTab.id, {type: "pdfUrl", requestId: documentID,  token: bearerToken});
                }
            });
        }
    },
    {urls: ["https://api-nl-prod.medtroniccarelink.net/CareLink.API.Service/api/documents/*"], types: ["xmlhttprequest"]},
  );

async function getDataFromPdf(textArray) {

    let pdfDataArray = [];

    const implantModelRegex = /(?<=(Date of birth: \d{2}-[A-Z|a-z]{3}-\d{4}  ))(.*)(?=. SN:)/;
    const patientNameRegex = /\w+\W+\w+\W+\w+$/; 
    const episodeDurationRegex = /(?<=Duration:\s+)\s*(\d+)\s*(s|min|h)/;
    const episodeNumberRegex = /EGM REPORT - Episode (\d+)/;
    const episodeDateRegex = /Episode date: (\d{2}-[A-Za-z]{3}-\d{4})/;
    const episodeTypeRegex = /Rhythm: (.*?)\s+Duration:/;

    console.log(textArray[0]);

    for (const textContent of textArray) {
        const pdfData = {
            system : "Microport",
            episodeNumber : textContent.match(episodeNumberRegex)?.[1],
            episodeDate : textContent.match(episodeDateRegex)?.[1],
            episodeDuration: convertDurationToSeconds(textContent.match(episodeDurationRegex)?.[0], "Microport"),
            episodeType : textContent.match(episodeTypeRegex)?.[1],
            patientName : textContent.match(patientNameRegex)?.[0],
            implantModel : textContent.match(implantModelRegex)?.[0]
        };

        //do not create metadata for blank pages
        if(pdfData.episodeNumber) {
            pdfDataArray.push(pdfData);
        }
    }
   // duplicate removal, for multiple pages PDFs
   return pdfDataArray.filter((item, index, self) =>
   index === self.findIndex((t) => (
     t.episodeNumber === item.episodeNumber && t.episodeDate === item.episodeDate
   ))
 );
}

async function splitPdfByEpisodes(base64, episodePageCounts) {
    const sourcePdfDoc = await pdflib.PDFDocument.load(base64);
    let currentPageIndex = 0;
    let promises = [];

    for (let episodeIndex = 0; episodeIndex < episodePageCounts.length; episodeIndex++) {
        const pageCount = episodePageCounts[episodeIndex];
        const newPdfDoc = await pdflib.PDFDocument.create();
        
        for (let i = 0; i < pageCount; i++) {
            const [copiedPage] = await newPdfDoc.copyPages(sourcePdfDoc, [currentPageIndex + i]);
            newPdfDoc.addPage(copiedPage);
        }
        
        currentPageIndex += pageCount;
        const pdfBytes = await newPdfDoc.save();
        const base64String = await uint8ArrayToBase64(new Uint8Array(pdfBytes)); // S'assurer d'utiliser await ici

        const key = `file_${episodeIndex}`;
        const obj = {};
        obj[key] = base64String;

        const promise = chrome.storage.local.set(obj);
        console.log(`fichier ${key} uploadé`);
        promises.push(promise);
    }

    // Attendre que toutes les promesses soient résolues
    await Promise.all(promises);
}

async function getEpisodeLength(textArray) {
    const lengthArray = []; //contiendra la longueur de chaque épisode du PDF
    let currentEpisodeNumber = 1; // Numéro d'épisode à faire concorder avec chaque élément de textArray
    lengthArray[currentEpisodeNumber-1] = 0; //attribution d'une valeur de départ au lengthArray

    for(let i = 0; i < textArray.length; i++) {
        if(textArray[i].startsWith(`EGM REPORT - Episode ${currentEpisodeNumber}`)) {
            lengthArray[currentEpisodeNumber-1]++;
        } else if (i != textArray.length - 1) {
            currentEpisodeNumber++;
            lengthArray[currentEpisodeNumber-1]= 1; //initialise la longueur du nouvel épisode
        }
    }
    return lengthArray;
}

async function compressImagesToZip(imagesArray) {
    let zip = new JSZip();
    imagesArray.forEach((image, index) => {
        const imgData = image.split(';base64,').pop();
        zip.file(`image_${index+1}.png`, imgData, {base64:true});
    });

    const content = await zip.generateAsync({type:"blob"});
    const zipFile = new File([content], "file.zip", { type: "application/zip" });
    return zipFile;
}

async function encryptData(episode_info) {
  // Récupérer le pepper sous forme de chaîne hex
  const { pepper } = await chrome.storage.local.get("pepper");
  if (typeof pepper !== "string" || !/^[0-9a-fA-F]{64}$/.test(pepper)) {
    throw new Error("Pepper invalide ou absent : must be 64 hex chars");
  }

  // Convertir en WordArray CryptoJS
  const pepperWA = CryptoJS.enc.Hex.parse(pepper);

  // Vérifier les champs obligatoires
  const { patient_id, system, episode_type, date, time } = episode_info;
  if (!patient_id || !system || !episode_type || !date || !time) {
    throw new Error("Données manquantes pour le chiffrement");
  }

  // Construire la chaîne épisode
  const episodeString = `${patient_id}_${system}_${episode_type}_${date}_${time}`;

  // HMAC pour episodeId et patientId
  const episodeId = CryptoJS.HmacSHA256(episodeString, pepperWA).toString();
  const patientId = CryptoJS.HmacSHA256(patient_id, pepperWA).toString();

  return { patientId, episodeId };
}

async function getCredentials(name, password) {
    try {
        const response = await fetch("http://musicp.chu-bordeaux.fr:9000/api/connect/keycloak", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: `username=${encodeURIComponent(name)}&password=${encodeURIComponent(password)}`
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        const json = await response.json();
        console.log("API Response:", json);
        return json;
    } catch (error) {
        console.error("Failed to fetch credentials:", error.message);
        return null;
    }
}

async function uploadEgm(bearer, metadata, egm_file) {
    const myHeaders = new Headers();
    myHeaders.append("Authorization", `Bearer ${bearer}`);

    let file;

    if(metadata.system == "Boston" || metadata.system == "Biotronik") {
        console.log("system: ", metadata.system);
        file = new File([egm_file], `${metadata.episodeId}.svg`, { type: 'image/svg+xml' });
    } else {
        console.log("system: ", metadata.system);
        file = new File([egm_file], `${metadata.episodeId}.zip`, { type: "application/zip" });
    }

    const formdata = new FormData();
    formdata.append("system", metadata.system);
    formdata.append("patientId", metadata.patientId);
    formdata.append("episodeId", metadata.episodeId);
    formdata.append("episodeType", metadata.episodeType);
    formdata.append("episodeDuration", metadata.episodeDuration);
    formdata.append("model", metadata.implantModel)
    formdata.append("EGM", file);

    console.log(metadata.episodeId, metadata.patientId, metadata.episodeDuration, metadata.episodeType, metadata.implantModel, file);

    const requestOptions = {
        method: "POST",
        headers: myHeaders,
        body: formdata,
        redirect: "follow"
    };

    try {
        const response = await fetch("http://musicp.chu-bordeaux.fr:9000/api/upload/egm", requestOptions);
        const contentType = response.headers.get("content-type");

        let responseBody;
        if (contentType && contentType.includes("application/json")) {
            responseBody = await response.json();  // Parse JSON if the response is JSON
        } else {
            responseBody = await response.text();  // Otherwise, treat as text
        }

        if (!response.ok) {
            throw new Error(`Error uploading the EGM: ${response.status} ${response.statusText} - ${JSON.stringify(responseBody)}`);
        }

        return {
            status: response.status,
            headers: response.headers,
            body: responseBody
        };
    } catch (error) {
        console.error("Failed to upload EGM:", error);
        console.log(error);
    }
}

async function saveUserAnnotation(bearer, metadata) {
    try {
        const myHeaders = new Headers();
        myHeaders.append("Authorization", `Bearer ${bearer}`);
    
        const formdata = new FormData();
        formdata.append("system", `${metadata.system}`);
        formdata.append("patientId", `${metadata.patientId}`);
        formdata.append("episodeId", `${metadata.episodeId}`);
        formdata.append("diagnosis", `${metadata.diagnosis}`);
    
        const requestOptions = {
        method: "POST",
        headers: myHeaders,
        body: formdata,
        redirect: "follow"
        };
    
        const response = await fetch(`http://musicp.chu-bordeaux.fr:9000/api/user/annotations/new?alert=${metadata.isAlert}`, requestOptions);
        return await response.json();  
    } catch (error) {
        console.error("error sending the annotation: ", error);
        return error;
    }

}

async function getAnnotation(metadata) {

    const bearer = await getCredentials('jtoucoula', 'admin');
    const myHeaders = new Headers();
    myHeaders.append("accept", "application/json");
    myHeaders.append("Authorization", `Bearer ${bearer.access_token}`);
    
    const requestOptions = {
      method: "GET",
      headers: myHeaders,
      redirect: "follow"
    };
    
    const response = await fetch(`http://musicp.chu-bordeaux.fr:9000/api/user/annotation/get?system=${metadata.system}&patientId=${metadata.patientId}&episodeID=${metadata.episodeId}`, requestOptions);
    if (!response.ok) {
        const error = await response.text();
        console.error("error getting episode annotation: ", error)
        return false;
    }
    else {
        const json = await response.json();
        console.log("json:", json);
        return json[json.length-1].annotation;
    }
}

async function handlePdfTreated(message) {
    const dataObject = message.dataObject;
    console.log("Data received from the content script:", dataObject);

    try {
        if (["Medtronic", "Microport", "Abbott"].includes(dataObject.metadata.system)) {
            const zipFile = await compressImagesToZip(dataObject.files);
            dataObject.files = zipFile;
        } else if (["Biotronik", "Boston"].includes(dataObject.metadata.system)) {
            const blob = new Blob([dataObject.files], {type: 'image/svg+xml'});
            
            dataObject.files = blob;
        }

        if (dataObject.metadata.isAlert) {
            const response_alert = await handleAlertList(dataObject);
            if (response_alert) {
                console.log("Alert list handled successfully");
                const array = await chrome.storage.local.get("Alert Array");
                console.log("Alert Array:", array);
            }
        }

        const bearer = await getCredentials('jtoucoula', 'admin');
        console.log("Bearer token received:", bearer.access_token);
        if (!dataObject.isAnnotated) {
            const uploadResponse = await uploadEgm(bearer.access_token, dataObject.metadata, dataObject.files);
            console.log("Upload response:", uploadResponse);
        } else {
            console.log("Episode already annotated, not uploading again.");
        }

        if (dataObject.metadata.diagnosis) {
            const annotationResponse = await saveUserAnnotation(bearer.access_token, dataObject.metadata);
            console.log("Annotation response:", annotationResponse);
        } else {
            console.log("No new diagnosis made for this episode.");
        }
    } catch (error) {
        console.error("Error processing the data object:", error);
        throw error;  // Re-throw the error after logging it
    }
}

async function handleAlertList(dataObject) {
    try {
        console.log("handling the alert");
        const result = await chrome.storage.local.get("alertArray");
        let alertArray = result.alertArray;
        let constructedUrl = "";
        let dateParam = encodeURIComponent(dataObject.metadata.episodeDate);
        console.log(dataObject.metadata);
        console.log(dateParam);

        if (!alertArray) {
            console.log("No alert array created on this post, creating a new one");
            alertArray = []; // Initialize the array if it does not exist.
        }

        switch (dataObject.metadata.system) {
            case 'Biotronik':
                console.log(dataObject.metadata.svg);
                const parameters = new URLSearchParams(dataObject.metadata.svg);
                constructedUrl = `https://www.biotronik-homemonitoring.com/hmsc_guiWeb/patient/monitoring/DisplayPatientContext.jsf?TopTabIdentifier=HOLTER&LowTabIdentifier=HOLTER_EPISODE&PatientIdentifier=${parameters.get("patient")}&extparam=${dateParam}`;
            break;
            case 'Boston':
                constructedUrl = `${dataObject.metadata.url}/${dateParam}`;
            break;
            case 'Medtronic': 
                constructedUrl = `${dataObject.metadata.url}/${dateParam}`;
            break;
        }

        alertArray.push(constructedUrl); // Add the new URL.
        console.log(alertArray);
        // Save the updated array back to local storage.
        await chrome.storage.local.set({ "alertArray": alertArray });
        return true;
    } catch (error) {
        console.error("Error handling the alert list:", error);
        return false;
    }
}

async function handleAlertPrinting(metadata) {

    console.log("metadata episode link: ", metadata.episodeLink);

    switch (metadata.system) {
        case "Boston":
        case "Medtronic":
            console.log("boston system detected for printing the alert");
            chrome.tabs.create({url: metadata.episodeLink, active: false});
            break;
        case "Microport":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Biotronik":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        case "Abbott":
            console.log("automatic redirection for alerts not implemented yet");
            break;
        default:
            console.error("error: invalid manufacturer: ", metadata.system);
            break;
    }
}
