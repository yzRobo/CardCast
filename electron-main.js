// electron-main.js - Desktop shell for CardCast.
//
// CardCast is a localhost web app. This wraps it so a normal user can double-click
// one application instead of running a Node server by hand: it boots the existing
// Express server in this process, then shows it in a window. The web UI, overlays,
// and control pages are unchanged - they are still served over http://localhost so
// OBS browser sources keep working exactly as before.
const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = 3888;
const APP_URL = `http://localhost:${PORT}`;

// GitHub repo used for the in-app update check (see checkForUpdates).
const REPO = 'yzRobo/CardCast';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

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

// ---- In-app update check -------------------------------------------------
// CardCast is not code-signed and ships as a normal installer, so rather than a
// silent background auto-updater we do the simple, robust thing: ask GitHub for
// the latest release and, if it is newer than this build, offer to open the
// download page. Runs automatically on launch and from the Help menu.

// True when semver-ish string `latest` is greater than `current` (tolerates a
// leading "v" and missing patch components).
function isNewerVersion(latest, current) {
    const parts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const a = parts(latest);
    const b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
        const req = https.get(
            `https://api.github.com/repos/${REPO}/releases/latest`,
            { headers: { 'User-Agent': 'CardCast', 'Accept': 'application/vnd.github+json' }, timeout: 10000 },
            (res) => {
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub returned HTTP ${res.statusCode}`)); }
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
            }
        );
        req.on('timeout', () => req.destroy(new Error('request timed out')));
        req.on('error', reject);
    });
}

function showMessage(opts) {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
}

// Check GitHub for a newer release. When `silent` (the automatic launch check)
// it stays quiet unless an update is found; the manual menu check reports the
// up-to-date and error cases too.
async function checkForUpdates({ silent = true } = {}) {
    try {
        const release = await fetchLatestRelease();
        const latest = release.tag_name || '';
        const current = app.getVersion();
        if (isNewerVersion(latest, current)) {
            const pick = await showMessage({
                type: 'info',
                title: 'Update available',
                message: `CardCast ${latest.replace(/^v/i, '')} is available.`,
                detail: `You have ${current}. Open the download page to get the new installer, then run it to update.`,
                buttons: ['Download', 'Later'],
                defaultId: 0,
                cancelId: 1,
            });
            if (pick.response === 0) shell.openExternal(release.html_url || RELEASES_PAGE);
        } else if (!silent) {
            await showMessage({
                type: 'info',
                title: 'No updates',
                message: 'CardCast is up to date.',
                detail: `You are on the latest version (${current}).`,
                buttons: ['OK'],
            });
        }
    } catch (err) {
        console.warn('Update check failed:', err.message);
        if (!silent) {
            await showMessage({
                type: 'warning',
                title: 'Update check failed',
                message: 'Could not check for updates.',
                detail: `${err.message}\n\nYou can check manually at:\n${RELEASES_PAGE}`,
                buttons: ['Open Releases Page', 'OK'],
                defaultId: 1,
                cancelId: 1,
            }).then((pick) => { if (pick.response === 0) shell.openExternal(RELEASES_PAGE); });
        }
    }
}

// A minimal application menu so users have a manual "Check for Updates" and a
// reload/devtools escape hatch for troubleshooting. Hidden by default
// (autoHideMenuBar); press Alt to reveal it.
function buildAppMenu() {
    const template = [
        {
            label: 'CardCast',
            submenu: [
                { label: 'Check for Updates...', click: () => checkForUpdates({ silent: false }) },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                { label: 'Check for Updates...', click: () => checkForUpdates({ silent: false }) },
                { label: 'View Releases Page', click: () => shell.openExternal(RELEASES_PAGE) },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
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
    buildAppMenu();
    // Let the in-app "Check for Updates" button and the header version badge talk
    // to the desktop shell (see preload.js). The manual check reuses the same
    // dialog as the automatic launch check.
    ipcMain.handle('cardcast:check-for-updates', () => checkForUpdates({ silent: false }));
    ipcMain.handle('cardcast:get-version', () => app.getVersion());
    createWindow();
    try {
        await waitForServer();
        if (mainWindow) await mainWindow.loadURL(APP_URL);
        // Quietly check for a newer release once the app is up. Packaged builds
        // only, so dev runs (electron .) don't prompt against published releases.
        if (app.isPackaged) setTimeout(() => checkForUpdates({ silent: true }), 4000);
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
