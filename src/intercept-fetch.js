export async function ensureMedtronicPageBridge() {
    try {
        const response = await chrome.runtime.sendMessage({
            action: "ensure medtronic page bridge"
        });

        if (!response?.ok) {
            throw new Error(response?.error || "Unknown Medtronic page bridge injection error");
        }

        console.log("[PASTEC] Medtronic page bridge ensured");
        return true;
    } catch (error) {
        console.error("[PASTEC] Failed to ensure Medtronic page bridge", error);
        return false;
    }
}
