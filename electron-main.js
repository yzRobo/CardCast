// electron-main.js - Desktop shell for CardCast.
//
// CardCast is a localhost web app. This wraps it so a normal user can double-click
// one application instead of running a Node server by hand: it boots the existing
// Express server in this process, then shows it in a window. The web UI, overlays,
// and control pages are unchanged - they are still served over http://localhost so
// OBS browser sources keep working exactly as before.
const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFileSync, spawn } = require('child_process');

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
// Stops early when server.js reports a startup failure, so a port clash surfaces
// immediately with a usable message instead of after the full timeout.
function waitForServer(timeoutMs = 90000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (global.CARDCAST_STARTUP_ERROR) return reject(new Error(global.CARDCAST_STARTUP_ERROR));
            const req = http.get(APP_URL, (res) => { res.resume(); resolve(); });
            req.on('error', () => {
                if (global.CARDCAST_STARTUP_ERROR) return reject(new Error(global.CARDCAST_STARTUP_ERROR));
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`CardCast is taking longer than expected to start on port ${PORT}.`));
                } else {
                    setTimeout(attempt, 300);
                }
            });
        };
        attempt();
    });
}

// ---- Updates ---------------------------------------------------------------
// The app updates itself: electron-updater reads the release feed published
// alongside each GitHub release (latest.yml), downloads the new installer with a
// progress bar, and swaps the app over on restart. The installer is oneClick, so
// installing is silent - the user only sees the two prompts below.
//
// checkForUpdates() falls back to the old behaviour (ask GitHub's API, then offer
// to open the download page) whenever the updater cannot run: unpackaged dev runs,
// a release with no latest.yml, or any updater error. That keeps the button
// useful instead of dead when something upstream is missing.

let updateInProgress = false;   // a download is running or finished, awaiting restart
let quittingToInstall = false;  // set just before quitAndInstall, see window-all-closed
let updater = null;

// Load electron-updater lazily. Reading its `autoUpdater` export runs a getter
// that constructs the updater immediately, and the constructor reads
// app.getVersion() - so requiring it at the top of this file crashes the process
// before Electron has finished initializing. Resolving it on first use keeps
// startup independent of the updater entirely.
function getUpdater() {
    if (updater) return updater;
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;        // ask before using someone's bandwidth
    updater.autoInstallOnAppQuit = true; // if they pick "Later", it lands on next quit
    updater.logger = null;
    return updater;
}

// ---- One-time cleanup of a pre-2.1 install ---------------------------------
// Before 2.1 the installer let people choose the folder, so some installs are
// machine-wide (usually C:\Program Files\CardCast). 2.1 installs per-user, which
// is what lets updates install silently without a UAC prompt - but it means those
// older copies are left behind, and the all-users Start Menu shortcut still points
// at the stale one. Detect that once and offer to remove it.

// Split an UninstallString into its executable and arguments. The value looks
// like `"C:\Program Files\CardCast\Uninstall CardCast.exe" /allusers`, and the
// /allusers switch matters - without it the uninstaller runs in per-user mode and
// finds nothing to remove.
function parseUninstallCommand(value) {
    const raw = String(value || '').trim();
    if (raw.startsWith('"')) {
        const end = raw.indexOf('"', 1);
        if (end > 1) {
            return { exe: raw.slice(1, end), args: raw.slice(end + 1).trim() };
        }
    }
    const match = raw.match(/^(.*?\.exe)(?:\s+(.*))?$/i);
    return match ? { exe: match[1], args: (match[2] || '').trim() } : { exe: raw, args: '' };
}

// electron-builder names the uninstall key with a GUID derived from the appId
// (com.yzrobo.cardcast), so it is the same for every CardCast build. Reading that
// one key is exact and instant; walking the whole Uninstall tree with `reg /s` is
// both slow and unreliable across the 32- and 64-bit registry views.
const UNINSTALL_KEY = '56f7e164-5fdc-51ff-b90a-955a2f5c10b4';

function findLegacyInstall() {
    if (process.platform !== 'win32' || !app.isPackaged) return null;
    const ourDir = path.dirname(app.getPath('exe')).toLowerCase();
    // Machine-wide only. The per-user key is this install's own entry.
    const keys = [
        `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}`,
        `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}`,
    ];
    for (const key of keys) {
        let out;
        try {
            out = execFileSync('reg', ['query', key], {
                encoding: 'utf8', timeout: 8000, windowsHide: true
            });
        } catch (err) {
            continue; // no machine-wide install in this view
        }
        // Prefer the quiet form so removing it is a single UAC prompt.
        const raw = (out.match(/QuietUninstallString\s+REG_SZ\s+(.+)/i)
            || out.match(/UninstallString\s+REG_SZ\s+(.+)/i) || [])[1];
        if (!raw) continue;

        const { exe, args } = parseUninstallCommand(raw);
        if (!exe || !fs.existsSync(exe)) continue;

        const dir = path.dirname(exe);
        if (!dir || dir.toLowerCase() === ourDir) continue;

        const version = (out.match(/DisplayVersion\s+REG_SZ\s+(.+)/i) || [])[1];
        return { exe, args, dir, version: version ? version.trim() : null };
    }
    return null;
}

// Ask at most once, so declining is respected on every later launch.
async function offerLegacyCleanup() {
    // Never stack this on top of an update prompt or a running download; the
    // check is cheap and there will be another launch.
    if (updateInProgress) return;

    const marker = path.join(app.getPath('userData'), '.legacy-install-checked');
    try {
        if (fs.existsSync(marker)) return;
    } catch (err) { /* fall through and just ask */ }

    const legacy = findLegacyInstall();
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch (err) { /* best effort */ }
    if (!legacy) return;

    const pick = await showMessage({
        type: 'info',
        title: 'Older CardCast found',
        message: `An older CardCast${legacy.version ? ` (${legacy.version})` : ''} is still installed.`,
        detail: `It is in ${legacy.dir}.\n\nCardCast now installs per user so it can update itself without asking for administrator rights. The copy you are using is the new one - the old install is no longer used, but its Start Menu shortcut may still open the old version.\n\nRemoving it needs administrator rights.`,
        buttons: ['Remove Old Version', 'Keep It'],
        defaultId: 0,
        cancelId: 1,
    });
    if (pick.response === 0) runElevated(legacy.exe, legacy.args);
}

// Launch a program elevated. Spawning it directly fails when the target needs
// administrator rights, so go through ShellExecute (-Verb RunAs), which is what
// raises the UAC prompt. Single quotes are doubled for PowerShell's quoting.
function runElevated(exe, args) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const command = args
        ? `Start-Process -FilePath ${q(exe)} -ArgumentList ${q(args)} -Verb RunAs`
        : `Start-Process -FilePath ${q(exe)} -Verb RunAs`;
    try {
        const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
            detached: true, stdio: 'ignore', windowsHide: true
        });
        child.unref();
    } catch (err) {
        console.warn('Could not start the old uninstaller:', err.message);
    }
}

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

// Push download progress to the renderer so the header can show a live bar, and
// to the taskbar button so it is visible when the window is not focused.
function sendProgress(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

// Manual-download fallback: what the app did before it could update itself. Used
// for dev runs and whenever the updater cannot complete.
async function manualUpdateFallback({ silent, reason }) {
    try {
        const release = await fetchLatestRelease();
        const latest = release.tag_name || '';
        const current = app.getVersion();
        if (isNewerVersion(latest, current)) {
            const pick = await showMessage({
                type: 'info',
                title: 'Update available',
                message: `CardCast ${latest.replace(/^v/i, '')} is available.`,
                detail: `You have ${current}. This copy could not update itself${reason ? ` (${reason})` : ''}, so open the download page to get the new installer and run it.`,
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
            const pick = await showMessage({
                type: 'warning',
                title: 'Update check failed',
                message: 'Could not check for updates.',
                detail: `${err.message}\n\nYou can check manually at:\n${RELEASES_PAGE}`,
                buttons: ['Open Releases Page', 'OK'],
                defaultId: 1,
                cancelId: 1,
            });
            if (pick.response === 0) shell.openExternal(RELEASES_PAGE);
        }
    }
}

// Download the pending update, reporting progress, then offer to restart into it.
async function downloadAndInstall(version) {
    const autoUpdater = getUpdater();
    updateInProgress = true;
    sendProgress('cardcast:update-progress', { state: 'start', version, percent: 0 });

    const onProgress = (p) => {
        const percent = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
        sendProgress('cardcast:update-progress', { state: 'downloading', version, percent });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(percent / 100);
    };
    autoUpdater.on('download-progress', onProgress);

    try {
        await autoUpdater.downloadUpdate();
    } catch (err) {
        autoUpdater.removeListener('download-progress', onProgress);
        updateInProgress = false;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
        sendProgress('cardcast:update-progress', { state: 'error', version });
        await manualUpdateFallback({ silent: false, reason: `download failed: ${err.message}` });
        return;
    }

    autoUpdater.removeListener('download-progress', onProgress);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
    sendProgress('cardcast:update-progress', { state: 'ready', version, percent: 100 });

    const pick = await showMessage({
        type: 'info',
        title: 'Update ready',
        message: `CardCast ${version} is ready to install.`,
        detail: 'CardCast will close, install the update, and reopen. This takes a few seconds.\n\nIf you are live right now, choose Later and it will install the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
    });

    if (pick.response === 0) {
        quittingToInstall = true;
        // Let the dialog finish closing before the app tears itself down, and
        // drop the window-all-closed quit handler so it cannot race the installer.
        setImmediate(() => {
            app.removeAllListeners('window-all-closed');
            autoUpdater.quitAndInstall(true, true);
        });
    }
}

// Check for a newer release. When `silent` (the automatic launch check) it stays
// quiet unless an update is found; the manual check reports the up-to-date and
// error cases too.
async function checkForUpdates({ silent = true } = {}) {
    // Unpackaged dev runs have no app-update.yml; never let the updater touch them.
    if (!app.isPackaged) return manualUpdateFallback({ silent, reason: 'development build' });

    if (updateInProgress) {
        if (!silent) {
            await showMessage({
                type: 'info',
                title: 'Update in progress',
                message: 'An update is already downloading.',
                detail: 'You will be asked to restart as soon as it is ready.',
                buttons: ['OK'],
            });
        }
        return;
    }

    let result;
    try {
        result = await getUpdater().checkForUpdates();
    } catch (err) {
        console.warn('Auto-update check failed:', err.message);
        return manualUpdateFallback({ silent, reason: err.message });
    }

    const current = app.getVersion();
    const version = result && result.updateInfo && result.updateInfo.version;

    if (!version || !isNewerVersion(version, current)) {
        if (!silent) {
            await showMessage({
                type: 'info',
                title: 'No updates',
                message: 'CardCast is up to date.',
                detail: `You are on the latest version (${current}).`,
                buttons: ['OK'],
            });
        }
        return;
    }

    const pick = await showMessage({
        type: 'info',
        title: 'Update available',
        message: `CardCast ${version} is available.`,
        detail: `You have ${current}. CardCast can download and install this for you - you will be asked before it restarts.`,
        buttons: ['Update Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
    });
    if (pick.response === 0) await downloadAndInstall(version);
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

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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
        // Packaged builds take their taskbar/Explorer icon from the exe resource;
        // this is what gives `electron .` dev runs the real icon too.
        icon: path.join(__dirname, 'assets', 'icon.ico'),
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

// Only one copy may run: the server owns a fixed port, so a second copy could
// never bind it and would sit waiting on a port the first copy already holds -
// which is what produced the intermittent "CardCast could not start" on launch.
// A second launch now just focuses the window that is already open.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    // Start the Express server immediately, independent of window/GPU
    // initialization, so the server and OBS browser sources come up even if the
    // desktop window is slow to appear (or on a machine with limited graphics).
    startServer();
}

app.whenReady().then(async () => {
    if (!isPrimaryInstance) return; // another copy is already running
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
        if (app.isPackaged) {
            setTimeout(() => checkForUpdates({ silent: true }), 4000);
            // After the update prompt, so the two never stack on the same launch.
            setTimeout(() => {
                offerLegacyCleanup().catch((err) => console.warn('Legacy install check failed:', err && err.message));
            }, 12000);
        }
    } catch (err) {
        console.error(err);
        // Show what actually went wrong. "Close and reopen" is useless advice when
        // the cause is a port already in use - reopening hits the same wall.
        const reason = (err && err.message) || 'CardCast could not start.';
        if (mainWindow) mainWindow.loadURL(loadingPage(`${escapeHtml(reason)}<br><br>Close CardCast completely (check the system tray and Task Manager) and open it again. If a program other than CardCast is using port ${PORT}, close that program first.`));
    }
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// The Express server runs in this process, so quitting the app stops it too.
// Skipped while quitting into the installer, which drives its own shutdown.
app.on('window-all-closed', () => { if (!quittingToInstall) app.quit(); });
