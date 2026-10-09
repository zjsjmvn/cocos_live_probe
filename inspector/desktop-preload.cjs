const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("liveProbeDesktop", {
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
