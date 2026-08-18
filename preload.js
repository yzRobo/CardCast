// preload.js - secure bridge between the renderer (the web UI) and the Electron
// main process. Exposes a tiny, explicit API so the in-app "Check for Updates"
// button can trigger the same native update check used automatically on launch,
// the header can display the real app version, and the header can show download
// progress while an update is being fetched.
//
// Only present in the packaged/dev desktop app. The plain web and portable builds
// have no preload, so window.cardcastDesktop is undefined there and the UI falls
// back to opening the Releases page / reading /api/version.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cardcastDesktop', {
    checkForUpdates: () => ipcRenderer.invoke('cardcast:check-for-updates'),
    getVersion: () => ipcRenderer.invoke('cardcast:get-version'),
    // Report download progress: { state: 'start'|'downloading'|'ready'|'error',
    // version, percent }. Returns an unsubscribe function.
    onUpdateProgress: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('cardcast:update-progress', listener);
        return () => ipcRenderer.removeListener('cardcast:update-progress', listener);
    },
});
