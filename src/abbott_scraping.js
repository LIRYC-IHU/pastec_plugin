import {
    base64ToBlob,
    bitmapsToBase64,
    convertDurationToSeconds,
    injectGenericHTML,
    loadPdfAndExtractImages,
    processViewerEpisode,
    showExtensionError
} from "./content";
import { authenticatedFetch } from "./auth";

const API_URL = process.env.API_URL;
const ABBOTT_HOSTNAME = "europe.merlin.net";
const ABBOTT_ROW_SELECTOR = 'tr[id^="mnu_episode-egm-non-icm__"]';
const ABBOTT_EGM_ICON_SELECTOR = ".egm__icon";
const ABBOTT_EGM_LINK_SELECTOR = 'td[id^="dtl_episode-egm-non-icm_td-episodeDateTime"] .fakeLink';
const ABBOTT_DIAGNOSIS_MAP_URL = chrome.runtime.getURL("diagnosis-maps.json");
const ABBOTT_NATIVE_IFRAME_SELECTOR = 'iframe[src*="/assets/pdfjs/web/viewer.html"], iframe[src*="viewerId=popup-pdf-viewer"]';
const ABBOTT_NATIVE_VIEWER_SUPPRESSION_MS = 8000;
const ABBOTT_TABLE_WAIT_MS = 10000;

let abbottLabels = {};
let abbottInitialized = false;
let abbottProcessing = false;
let activeOverlayBlobUrl = null;
let abbottNativeViewerObserver = null;
let abbottNativeViewerTimeoutId = null;

console.log("abbott_scraping.js loaded");

function isAbbottEuEpisodesPage() {
    return (
        window.location.hostname === ABBOTT_HOSTNAME
        && window.location.pathname.includes("/episodesAndEGM")
    );
}

function getTrimmedText(selector, root = document) {
    return root.querySelector(selector)?.textContent?.trim() || "";
}

function parseImplantModel(description) {
    if (!description) {
        return "UNKNOWN";
    }

    return description
        .split("(")[0]
        .replace(/,\s*$/, "")
        .trim() || description.trim();
}

function parseEpisodeDateTime(value) {
    const [datePart = "", timePart = ""] = value.split(",");
    return {
        episodeDate: datePart.trim(),
        episodeTime: timePart.trim(),
        episodeDateTime: value.trim()
    };
}

function getAbbottTriggerTarget(target) {
    if (!(target instanceof Element)) {
        return null;
    }

    return target.closest(`${ABBOTT_EGM_ICON_SELECTOR}, ${ABBOTT_EGM_LINK_SELECTOR}`);
}

function getWebsiteNotificationId() {
    return new URL(window.location.href).searchParams.get("websiteNotificationId") || "";
}

function removeNestedViewerContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    let containerToRemove = container;
    if (container.parentElement && container.parentElement.id === containerId) {
        containerToRemove = container.parentElement;
    }

    containerToRemove.remove();
}

function closeAbbottOverlay() {
    removeNestedViewerContainer("pdf-viewer");

    if (activeOverlayBlobUrl) {
        URL.revokeObjectURL(activeOverlayBlobUrl);
        activeOverlayBlobUrl = null;
    }
}

function clearAbbottNativeViewerSuppression() {
    if (abbottNativeViewerObserver) {
        abbottNativeViewerObserver.disconnect();
        abbottNativeViewerObserver = null;
    }

    if (abbottNativeViewerTimeoutId) {
        window.clearTimeout(abbottNativeViewerTimeoutId);
        abbottNativeViewerTimeoutId = null;
    }
}

function removeAbbottNativeViewer() {
    let removed = false;

    document.querySelectorAll(ABBOTT_NATIVE_IFRAME_SELECTOR).forEach((iframe) => {
        const removableRoot = iframe.closest(".cdk-overlay-pane")
            || iframe.closest(".popup-pdf-panel")
            || iframe.closest('[role="dialog"]')
            || iframe.closest(".mat-dialog-container")
            || iframe;

        removableRoot.remove();
        removed = true;
    });

    if (removed) {
        document.querySelectorAll(".cdk-overlay-backdrop, .cdk-overlay-dark-backdrop").forEach((backdrop) => {
            backdrop.remove();
        });
    }

    return removed;
}

function armAbbottNativeViewerSuppression() {
    clearAbbottNativeViewerSuppression();
    removeAbbottNativeViewer();

    if (!document.body) {
        return;
    }

    abbottNativeViewerObserver = new MutationObserver(() => {
        if (removeAbbottNativeViewer()) {
            console.log("Abbott native PDF viewer suppressed");
        }
    });

    abbottNativeViewerObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    abbottNativeViewerTimeoutId = window.setTimeout(() => {
        clearAbbottNativeViewerSuppression();
    }, ABBOTT_NATIVE_VIEWER_SUPPRESSION_MS);
}

function waitForOverlayClose() {
    return new Promise((resolve) => {
        const handleClose = () => resolve({ closed: true });
        document.addEventListener("close_overlay", handleClose, { once: true });
    });
}

function waitForAbbottEpisodesTable(timeoutMs = ABBOTT_TABLE_WAIT_MS) {
    const existingTable = document.querySelector("#episode-egm-non-icm");
    if (existingTable) {
        return Promise.resolve(existingTable);
    }

    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            const table = document.querySelector("#episode-egm-non-icm");
            if (!table) {
                return;
            }

            observer.disconnect();
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
            resolve(table);
        });

        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });

        const timeoutId = window.setTimeout(() => {
            observer.disconnect();
            resolve(null);
        }, timeoutMs);
    });
}

async function loadAbbottLabels() {
    try {
        const response = await fetch(ABBOTT_DIAGNOSIS_MAP_URL);
        const diagnosisMaps = await response.json();
        const abbottMap = diagnosisMaps.find((entry) => entry.system === "Abbott");
        return abbottMap?.labels || {};
    } catch (error) {
        console.warn("Unable to load Abbott diagnosis map", error);
        return {};
    }
}

function getLabelsForEpisode(episodeType) {
    const labels = abbottLabels[episodeType];
    if (Array.isArray(labels)) {
        return labels;
    }

    showExtensionError(
        `Aucun diagnostic Abbott configuré pour "${episodeType}".`,
        "Diagnostic Abbott manquant"
    );
    return [];
}

async function encryptAbbottEpisode(patientName, episodeType, episodeDate, episodeTime) {
    const response = await chrome.runtime.sendMessage({
        action: "encrypt patient data",
        episode_info: {
            patient_id: patientName,
            system: "Abbott",
            episode_type: episodeType,
            date: episodeDate,
            time: episodeTime
        }
    });

    if (!response || response.status === "error" || !response.patientId || !response.episodeId) {
        throw new Error(response?.error || "Échec du chiffrement des identifiants Abbott.");
    }

    return response;
}

async function extractAbbottMetadata(row) {
    const patientName = getTrimmedText("#title_banner_name");
    const deviceDescription = getTrimmedText("#title_banner_deviceFullDescription");
    const transmissionDate = getTrimmedText("#lbl_transmission_summary_transmission_date")
        .replace(/^Transmission Date:\s*/i, "")
        .trim();
    const episodeDateTime = getTrimmedText('td[id^="dtl_episode-egm-non-icm_td-episodeDateTime"]', row);
    const episodeType = getTrimmedText('td[id^="dtl_episode-egm-non-icm_td-zoneType"]', row);
    const durationText = getTrimmedText('td[id^="dtl_episode-egm-non-icm_td-duration"]', row);
    const sourceEpisodeId = row.querySelector("input.episodeIdHdn")?.value?.trim() || "";
    const websiteNotificationId = getWebsiteNotificationId();

    if (!patientName || !episodeDateTime || !episodeType || !sourceEpisodeId || !websiteNotificationId) {
        throw new Error("Impossible de récupérer les métadonnées Abbott nécessaires depuis la page.");
    }

    const { episodeDate, episodeTime } = parseEpisodeDateTime(episodeDateTime);
    if (!episodeDate || !episodeTime) {
        throw new Error(`Date/heure Abbott invalide: "${episodeDateTime}"`);
    }

    const encryptedIds = await encryptAbbottEpisode(patientName, episodeType, episodeDate, episodeTime);

    return {
        patientName,
        patientId: encryptedIds.patientId,
        episodeId: encryptedIds.episodeId,
        implantModel: parseImplantModel(deviceDescription),
        implantDescription: deviceDescription,
        transmissionDate,
        episodeDateTime,
        episodeDate,
        episodeTime,
        episodeType,
        episodeDuration: Math.max(convertDurationToSeconds(durationText, "Abbott"), 0),
        durationText,
        system: "Abbott",
        url: window.location.href,
        sourceEpisodeId,
        websiteNotificationId
    };
}

async function fetchAbbottPdfBlob(metadata) {
    const response = await chrome.runtime.sendMessage({
        action: "abbott-fetch-pdf",
        episodeAndEgmId: metadata.sourceEpisodeId,
        websiteNotificationId: metadata.websiteNotificationId
    });

    if (!response?.ok) {
        throw new Error(response?.error || "Échec de récupération du PDF Abbott.");
    }

    const pdfBlob = base64ToBlob(response.base64, response.contentType || "application/pdf");
    if (!(pdfBlob instanceof Blob) || pdfBlob.size === 0) {
        throw new Error("Le PDF Abbott récupéré est vide ou invalide.");
    }

    return pdfBlob;
}

function buildAbbottPngFiles(dataUrls) {
    return dataUrls.map((dataUrl, index) => {
        const pngBlob = base64ToBlob(dataUrl, "image/png");
        if (!(pngBlob instanceof Blob) || pngBlob.size === 0) {
            throw new Error(`Impossible de convertir l'image Abbott ${index + 1} en PNG.`);
        }

        return new File([pngBlob], `egm_image_${index}.png`, { type: "image/png" });
    });
}

async function processEpisode(metadata, pdfBlob, blobUrl) {
    console.log("Processing Abbott episode", metadata);

    const formData = new FormData();
    formData.append("patient_id", metadata.patientId);
    formData.append("manufacturer", metadata.system.toLowerCase());
    formData.append("episode_type", metadata.episodeType);
    formData.append("implant_model", metadata.implantModel);
    formData.append("age_at_episode", "0");
    formData.append("episode_duration", metadata.episodeDuration.toString());
    formData.append("episode_id", metadata.episodeId);

    const response = await authenticatedFetch(`${API_URL}/episode/upload_episode`, {
        method: "POST",
        body: formData
    });

    const responseData = await response.json();
    console.log("Abbott upload_episode response", responseData);

    if (responseData?.episode_id) {
        metadata.episodeId = responseData.episode_id;
    }
    if (responseData?.patient_id) {
        metadata.patientId = responseData.patient_id;
    }

    if (responseData.exists && responseData.egm_uploaded) {
        return {
            annotated: responseData.annotated,
            exists: responseData.exists,
            egm_uploaded: true,
            ai_clients: responseData.ai_clients || [],
            jobs: responseData.jobs || []
        };
    }

    const images = await loadPdfAndExtractImages(blobUrl || pdfBlob, "abbott");
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error("Aucune image EGM Abbott n'a pu être extraite du PDF.");
    }

    const imageDataUrls = await bitmapsToBase64(images, "abbott");
    const pngFiles = buildAbbottPngFiles(imageDataUrls);

    const egmFormData = new FormData();
    pngFiles.forEach((file) => {
        egmFormData.append("files", file, file.name);
    });

    const episodeResponse = await authenticatedFetch(`${API_URL}/episode/${metadata.episodeId}/egm`, {
        method: "POST",
        body: egmFormData
    });

    const egmData = await episodeResponse.json();
    console.log("Abbott /egm response", egmData);

    return {
        annotated: responseData.annotated,
        exists: responseData.exists,
        egm_uploaded: true,
        ai_clients: egmData.ai_clients || [],
        jobs: egmData.jobs || []
    };
}

async function openAbbottViewer(metadata, pdfBlob) {
    closeAbbottOverlay();
    activeOverlayBlobUrl = URL.createObjectURL(pdfBlob);
    const blobUrl = activeOverlayBlobUrl;
    const uploadPromise = processEpisode(metadata, pdfBlob, blobUrl);
    uploadPromise.catch(() => {});

    await injectGenericHTML("pdf-viewer");

    const iframe = document.querySelector("#iframe");
    if (!iframe) {
        throw new Error("Le visualiseur PDF Abbott n'a pas pu être initialisé.");
    }
    iframe.src = blobUrl;

    const labels = getLabelsForEpisode(metadata.episodeType);
    const closePromise = waitForOverlayClose().then((result) => ({ type: "closed", result }));
    const viewerPromise = processViewerEpisode(metadata, labels, uploadPromise)
        .then((result) => ({ type: "processed", result }));

    const outcome = await Promise.race([viewerPromise, closePromise]);
    if (outcome.type === "processed") {
        document.dispatchEvent(new Event("close_overlay"));
    }

    return outcome.result;
}

async function handleAbbottEgmClick(icon, event) {
    if (abbottProcessing) {
        console.log("Abbott EGM processing already in progress, ignoring click.");
        return;
    }

    const row = icon.closest(ABBOTT_ROW_SELECTOR);
    const sourceEpisodeId = row?.querySelector("input.episodeIdHdn")?.value || "";

    if (!sourceEpisodeId) {
        console.log("Abbott trigger ignored because no EGM is available for this row", {
            eventType: event.type
        });
        return;
    }

    console.log("Abbott EGM trigger intercepted", {
        sourceEpisodeId,
        eventType: event.type
    });
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    abbottProcessing = true;
    armAbbottNativeViewerSuppression();

    try {
        if (!row) {
            throw new Error("Ligne Abbott introuvable pour l'icône EGM sélectionnée.");
        }

        const metadata = await extractAbbottMetadata(row);
        const pdfBlob = await fetchAbbottPdfBlob(metadata);
        await openAbbottViewer(metadata, pdfBlob);
    } catch (error) {
        console.error("Abbott EGM handling failed", error);
        closeAbbottOverlay();
        showExtensionError(error, "Erreur lors du chargement de l'EGM Abbott");
    } finally {
        clearAbbottNativeViewerSuppression();
        abbottProcessing = false;
    }
}

function installAbbottListeners() {
    document.addEventListener("close_overlay", closeAbbottOverlay);

    const tryHandleAbbottIconEvent = (event) => {
        const trigger = getAbbottTriggerTarget(event.target);
        if (!trigger) {
            return;
        }

        void handleAbbottEgmClick(trigger, event);
    };

    document.addEventListener("pointerdown", (event) => {
        if (typeof event.button === "number" && event.button !== 0) {
            return;
        }

        tryHandleAbbottIconEvent(event);
    }, true);

    document.addEventListener("click", tryHandleAbbottIconEvent, true);

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        tryHandleAbbottIconEvent(event);
    }, true);
}

async function initializeAbbott() {
    if (abbottInitialized) {
        return;
    }

    if (!isAbbottEuEpisodesPage()) {
        console.log("Abbott EU episodes page not detected, script not activated");
        return;
    }

    abbottLabels = await loadAbbottLabels();
    installAbbottListeners();
    const episodeTable = await waitForAbbottEpisodesTable();
    abbottInitialized = true;

    console.log("Abbott EU scraper initialized", {
        labels: abbottLabels,
        hasEpisodeTable: Boolean(episodeTable)
    });
}

window.addEventListener("load", () => {
    void initializeAbbott().catch((error) => {
        console.error("Abbott initialization failed", error);
        showExtensionError(error, "Erreur lors de l'initialisation Abbott");
    });
});
