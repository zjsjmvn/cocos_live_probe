const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame) contextBridge.exposeInMainWorld("liveProbeGameTools", {
    report: event => ipcRenderer.send("inspector:game-tool-event", event),
});
