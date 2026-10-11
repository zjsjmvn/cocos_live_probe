const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("liveProbeDesktop", {
    preferences: request => ipcRenderer.invoke("inspector:preferences", request),
    previewTool: request => ipcRenderer.invoke("inspector:preview-tool", request),
    onGameToolEvent: listener => {
        const callback = (_event, event) => listener(event);
        ipcRenderer.on("inspector:game-tool-event", callback);
        return () => ipcRenderer.removeListener("inspector:game-tool-event", callback);
    },
    saveTheme: theme => ipcRenderer.invoke("inspector:theme-save", theme),
    saveDensity: density => ipcRenderer.invoke("inspector:density-save", density),
    setPreviewBounds: bounds => ipcRenderer.send("inspector:bounds", bounds),
    reloadPreview: () => ipcRenderer.invoke("inspector:reload"),
    setDevToolsBounds: bounds => ipcRenderer.send("inspector:devtools-bounds", bounds),
    selectPanel: mode => ipcRenderer.invoke("inspector:panel-mode", mode),
    closeDevTools: () => ipcRenderer.invoke("inspector:devtools-close"),
    onPanelMode: listener => {
        const callback = (_event, mode) => listener(mode);
        ipcRenderer.on("inspector:panel-mode", callback);
        return () => ipcRenderer.removeListener("inspector:panel-mode", callback);
    },
    copyAIConnection: selectedUuid => ipcRenderer.invoke("inspector:ai-copy", selectedUuid),
    onAIActivity: listener => {
        const callback = (_event, activity) => listener(activity);
        ipcRenderer.on("inspector:ai-activity", callback);
        return () => ipcRenderer.removeListener("inspector:ai-activity", callback);
    },
});
