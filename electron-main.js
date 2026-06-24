// electron-main.js - Desktop shell for CardCast.
//
// CardCast is a localhost web app. This wraps it so a normal user can double-click
// one application instead of running a Node server by hand: it boots the existing
// Express server in this process, then shows it in a window. The web UI, overlays,
// and control pages are unchanged - they are still served over http://localhost so
// OBS browser sources keep working exactly as before.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 3888;
const APP_URL = `http://localhost:${PORT}`;

// The packaged app directory is read-only, so the database, image cache, and config
// live in the OS userData directory. server.js + tcg-api.js read CARDCAST_DATA_ROOT.
process.env.CARDCAST_DATA_ROOT = app.getPath('userData');
// Tell the server it is inside the desktop shell so it does not open a web browser.
process.env.CARDCAST_ELECTRON = '1';
// Point the server at the bundled metadata seed so first run copies it locally
// instead of downloading (the no-fetch path). Packaged: an extraResource beside the
// app. Dev (electron .): the in-repo database if one exists, else it downloads.
process.env.CARDCAST_BUNDLED_SEED = app.isPackaged
    ? path.join(process.resourcesPath, 'cardcast-seed.db')
    : path.join(__dirname, 'data', 'cardcast.db');

// Render with software GL if needed so the app still opens on machines with no or
// flaky GPU drivers (common on streaming/capture PCs). Must run before app is ready.
app.disableHardwareAcceleration();

let mainWindow = null;

function startServer() {
    try {
        require('./server.js'); // begins listening asynchronously
    } catch (err) {
        console.error('Failed to start the CardCast server:', err);
    }
}

// Resolve once the server answers on the port (first run may copy the seed first).
function waitForServer(timeoutMs = 90000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(APP_URL, (res) => { res.resume(); resolve(); });
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) reject(new Error('server did not start in time'));
                else setTimeout(attempt, 300);
            });
        };
        attempt();
    });
}

function loadingPage(message) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0b0f17;color:#e6ebf5;
      font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
    .box{text-align:center}.t{font-size:24px;font-weight:800;letter-spacing:.04em}
    .s{margin-top:10px;color:#94a3b8;font-size:14px;max-width:420px}
    .dots{margin-top:18px}.dot{display:inline-block;width:8px;height:8px;margin:0 3px;border-radius:50%;
      background:#6366f1;animation:b 1s infinite alternate}.dot:nth-child(2){animation-delay:.2s}
    .dot:nth-child(3){animation-delay:.4s}@keyframes b{to{opacity:.2;transform:translateY(-5px)}}
    </style></head><body><div class="box"><div class="t">CardCast</div><div class="s">${message}</div>
    <div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div></body></html>`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0b0f17',
        title: 'CardCast',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    // Open real external links in the system browser, not a second app window.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url) && !url.startsWith(APP_URL)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
    mainWindow.loadURL(loadingPage('Starting up. The first launch sets up the card database, which can take a moment.'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

// Start the Express server immediately, independent of window/GPU initialization,
// so the server and OBS browser sources come up even if the desktop window is slow
// to appear (or on a machine with limited graphics).
startServer();

app.whenReady().then(async () => {
    createWindow();
    try {
        await waitForServer();
        if (mainWindow) await mainWindow.loadURL(APP_URL);
    } catch (err) {
        console.error(err);
        if (mainWindow) mainWindow.loadURL(loadingPage('CardCast could not start. Please close and reopen the app.'));
    }
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// The Express server runs in this process, so quitting the app stops it too.
app.on('window-all-closed', () => app.quit());
