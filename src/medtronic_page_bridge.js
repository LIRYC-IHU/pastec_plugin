(() => {
    if (window.__PASTEC_MEDTRONIC_BRIDGE_INSTALLED__) {
        return;
    }

    window.__PASTEC_MEDTRONIC_BRIDGE_INSTALLED__ = true;

    const SUPPRESS_EVENT = "PASTEC_MEDTRONIC_SUPPRESS_POPUP";
    const CLEAR_EVENT = "PASTEC_MEDTRONIC_CLEAR_POPUP_SUPPRESSION";
    const PDF_BLOB_EVENT = "PASTEC_PDF_BLOB";
    const PDF_URL_EVENT = "PASTEC_PDF_URL";
    const DEBUG_PREFIX = "[PASTEC][MedtronicBridge]";
    const DEFAULT_SUPPRESSION_MS = 15000;
    let pendingTriggerUntil = 0;
    let suppressPopupUntil = 0;

    function isSuppressionActive() {
        return Date.now() < suppressPopupUntil;
    }

    function isPendingTriggerActive() {
        return Date.now() < pendingTriggerUntil;
    }

    function isPastecOverlayNode(node) {
        return node instanceof Element && Boolean(node.closest("#pdf-viewer"));
    }

    function isDocumentUrl(url) {
        if (typeof url !== "string" || !url) {
            return false;
        }

        try {
            const normalizedUrl = new URL(url, window.location.origin);
            return (
                /(^|\.)medtroniccarelink\.net$/i.test(normalizedUrl.hostname)
                && /^\/CareLink\.API\.Service\/api\/documents\/\d+$/.test(normalizedUrl.pathname)
            );
        } catch (error) {
            return false;
        }
    }

    function isBlockedPopupUrl(url) {
        if (!isSuppressionActive()) {
            return false;
        }

        if (!url || url === "about:blank") {
            return true;
        }

        return typeof url === "string" && url.startsWith("blob:");
    }

    function armPopupSuppression(activeForMs = DEFAULT_SUPPRESSION_MS) {
        suppressPopupUntil = Date.now() + activeForMs;
        console.debug(`${DEBUG_PREFIX} Popup suppression armed`, { activeForMs });
    }

    function dispatchPdfUrl(url, source) {
        window.dispatchEvent(new CustomEvent(PDF_URL_EVENT, {
            detail: { url, source }
        }));
    }

    function dispatchPdfBlob(url, blob) {
        window.dispatchEvent(new CustomEvent(PDF_BLOB_EVENT, {
            detail: { url, blob }
        }));
    }

    async function capturePdfResponse(url, response, source) {
        const contentType = response?.headers?.get?.("content-type") || "";
        if (!contentType.includes("application/pdf")) {
            return;
        }

        try {
            armPopupSuppression();
            dispatchPdfUrl(url, source);
            const blob = await response.clone().blob();
            dispatchPdfBlob(url, blob);
            pendingTriggerUntil = 0;
            console.debug(`${DEBUG_PREFIX} Captured PDF response`, { url, source, size: blob.size });
        } catch (error) {
            console.error(`${DEBUG_PREFIX} Failed to capture PDF response`, { url, source, error });
        }
    }

    function capturePdfXhr(url, xhr) {
        const contentType = xhr.getResponseHeader("content-type") || "";
        if (!contentType.includes("application/pdf")) {
            return;
        }

        let blob = null;
        if (xhr.response instanceof Blob) {
            blob = xhr.response;
        } else if (xhr.response instanceof ArrayBuffer) {
            blob = new Blob([xhr.response], { type: "application/pdf" });
        } else if ((xhr.responseType === "" || xhr.responseType === "text") && typeof xhr.responseText === "string" && xhr.responseText.length > 0) {
            blob = new Blob([xhr.responseText], { type: "application/pdf" });
        }

        if (!blob) {
            return;
        }

        armPopupSuppression();
        dispatchPdfUrl(url, "xhr");
        dispatchPdfBlob(url, blob);
        pendingTriggerUntil = 0;
        console.debug(`${DEBUG_PREFIX} Captured PDF XHR`, { url, size: blob.size });
    }

    function createSuppressedWindowProxy() {
        const locationState = {
            href: "",
            assign(value) {
                this.href = typeof value === "string" ? value : "";
            },
            replace(value) {
                this.href = typeof value === "string" ? value : "";
            }
        };

        return {
            closed: true,
            close() {},
            focus() {},
            blur() {},
            print() {},
            location: locationState,
            opener: null,
            document: {
                open() {
                    return this;
                },
                write() {},
                close() {}
            }
        };
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
        const url = typeof input === "string" ? input : input?.url;
        const response = await originalFetch(input, init);

        if (isDocumentUrl(url) && (isPendingTriggerActive() || isSuppressionActive())) {
            void capturePdfResponse(url, response, "fetch");
        }

        return response;
    };

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...args) {
        this.__pastecMedtronicUrl = typeof url === "string" ? url : "";
        return originalXhrOpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
        if (isDocumentUrl(this.__pastecMedtronicUrl)) {
            this.addEventListener("load", () => {
                if (isPendingTriggerActive() || isSuppressionActive()) {
                    capturePdfXhr(this.__pastecMedtronicUrl, this);
                }
            }, { once: true });
        }

        return originalXhrSend.apply(this, args);
    };

    const originalOpen = window.open.bind(window);
    window.open = function patchedOpen(url, name, specs) {
        if (isDocumentUrl(url) && isPendingTriggerActive()) {
            armPopupSuppression();
            dispatchPdfUrl(url, "window.open");
            pendingTriggerUntil = 0;
            console.debug(`${DEBUG_PREFIX} Suppressed direct PDF window.open`, { url });
            return createSuppressedWindowProxy();
        }

        if (isBlockedPopupUrl(url)) {
            console.debug(`${DEBUG_PREFIX} Suppressed popup`, { url });
            return createSuppressedWindowProxy();
        }

        return originalOpen(url, name, specs);
    };

    const observer = new MutationObserver((mutations) => {
        if (!isSuppressionActive()) {
            return;
        }

        for (const mutation of mutations) {
            if (mutation.type === "attributes" && mutation.target instanceof HTMLIFrameElement) {
                const iframe = mutation.target;
                if (iframe.src.startsWith("blob:") && !isPastecOverlayNode(iframe)) {
                    console.debug(`${DEBUG_PREFIX} Removed blob iframe`, { src: iframe.src });
                    iframe.remove();
                }
                continue;
            }

            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLIFrameElement)) {
                    continue;
                }

                if (node.src.startsWith("blob:") && !isPastecOverlayNode(node)) {
                    console.debug(`${DEBUG_PREFIX} Removed added blob iframe`, { src: node.src });
                    node.remove();
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"]
    });

    window.addEventListener(SUPPRESS_EVENT, (event) => {
        const activeForMs = Number(event?.detail?.activeForMs) || DEFAULT_SUPPRESSION_MS;
        pendingTriggerUntil = Date.now() + activeForMs;
        console.debug(`${DEBUG_PREFIX} PDF trigger armed`, { activeForMs });
    });

    window.addEventListener(CLEAR_EVENT, () => {
        pendingTriggerUntil = 0;
        suppressPopupUntil = 0;
        console.debug(`${DEBUG_PREFIX} Popup suppression cleared`);
    });
})();
