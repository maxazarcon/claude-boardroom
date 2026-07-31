'use strict';

// The desktop shell around the boardroom. It owns three things the plain
// command-line UI cannot do: it keeps the UI server alive in the tray, it can
// open a native folder picker, and it updates itself.
//
// The MCP server is deliberately NOT run in here. Claude spawns its own copy
// per session over stdio; this process just shares the same SQLite file.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');

const ui = require('../src/ui-server');
const wiring = require('../src/wiring');
const installer = require('../setup/install');
const { DB_PATH } = require('../src/db');

// Claude launches our MCP server and hook by invoking this same executable
// with ELECTRON_RUN_AS_NODE=1, so no separate Node install is required.
const RUNTIME = { packaged: app.isPackaged, execPath: process.execPath, isElectron: true };

let win = null;
let tray = null;
let serverUrl = null;
let quitting = false;

const updateState = {
  status: 'idle', // idle | checking | available | downloading | ready | current | error | unsupported
  version: null,
  percent: 0,
  message: null,
};

/* --------------------------------------------------------------- auto-update */

let autoUpdater = null;
function initUpdater() {
  if (!app.isPackaged) {
    updateState.status = 'unsupported';
    updateState.message = 'Updates only apply to an installed build.';
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    updateState.status = 'error';
    updateState.message = `updater unavailable: ${err.message}`;
    return;
  }

  autoUpdater.autoDownload = true;
  // Let the user finish what they are doing; the update lands on next launch
  // unless they explicitly choose to restart now.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.message = null;
  });
  autoUpdater.on('update-available', (info) => {
    updateState.status = 'downloading';
    updateState.version = info.version;
  });
  autoUpdater.on('update-not-available', () => {
    updateState.status = 'current';
    updateState.version = app.getVersion();
  });
  autoUpdater.on('download-progress', (p) => {
    updateState.status = 'downloading';
    updateState.percent = Math.round(p.percent);
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'ready';
    updateState.version = info.version;
    refreshTray();
  });
  autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.message = String(err && err.message ? err.message : err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000); // let the window settle first
  setInterval(check, 6 * 60 * 60 * 1000);
}

/* ------------------------------------------------------------- native bridge */

const bridge = {
  async appInfo() {
    return {
      status: 'ok',
      shell: true,
      version: app.getVersion(),
      packaged: app.isPackaged,
      url: serverUrl,
      db_path: DB_PATH,
      auto_start: app.getLoginItemSettings().openAtLogin,
      update: { ...updateState },
      wiring_health: { ...wiringHealth },
    };
  },

  async pickFolder() {
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'Choose your Claude projects folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { status: 'cancelled' };
    return { status: 'ok', path: res.filePaths[0] };
  },

  async checkUpdate() {
    if (!autoUpdater) {
      return { status: updateState.status, message: updateState.message };
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      updateState.status = 'error';
      updateState.message = String(err.message || err);
    }
    return { status: 'ok', update: { ...updateState } };
  },

  async installUpdate() {
    if (!autoUpdater || updateState.status !== 'ready') {
      return { status: 'error', message: 'no downloaded update is waiting' };
    }
    quitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { status: 'ok', message: 'Restarting to install…' };
  },

  // Opens the Claude Code CLI in a terminal so the user can complete the
  // one-time login it is asking for. We cannot do the OAuth flow for them, so
  // the most useful thing is to put them in front of it in one click.
  async openLogin({ folder } = {}) {
    const ui = require('../src/ui-server');
    const bin = ui.findClaudeBinary();
    if (!bin) {
      return {
        status: 'error',
        message: 'Could not find the claude CLI. Install it with: npm install -g @anthropic-ai/claude-code',
      };
    }
    const dir = folder && fs.existsSync(folder) ? folder : app.getPath('home');
    try {
      const script = wiring.writeLoginShim(bin, dir);
      const err = await shell.openPath(script);
      if (err) return { status: 'error', message: err };
      return {
        status: 'ok',
        message: 'A terminal is opening. Log in there, then come back and run the turn again.',
        folder: dir,
      };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  },

  async setAutoStart({ enabled }) {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    refreshTray();
    return { status: 'ok', auto_start: app.getLoginItemSettings().openAtLogin };
  },

  // Re-point Claude's config at this install. Runs automatically on launch;
  // exposed so the UI can offer it as a button too.
  async rewire({ projectsDir } = {}) {
    try {
      const res = installer.apply(RUNTIME, { projectsDir: projectsDir || null });
      return { status: 'ok', ...res };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  },
};

/* --------------------------------------------------------------------- shell */

function iconPath() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

// Right after an update, a config Claude Boardroom has read many times before
// can come back ENOENT for a while and then start working again on its own.
// Rather than show that to the user as a problem they cannot act on, retry
// quietly on a backoff and only give up — and only then say anything — once it
// has clearly stopped being a blip.
const RETRY_DELAYS = [3000, 8000, 20000, 45000, 90000];
let retryTimer = null;
let retriesLeft = RETRY_DELAYS.length;

const wiringHealth = { settled: false, attempts: 0, lastProblems: [], diagnosis: null };

function rewireQuietly({ scheduleRetries = true } = {}) {
  let res = null;
  try {
    res = installer.apply(RUNTIME, {});
  } catch (err) {
    console.error('[boardroom] could not update Claude config:', err.message);
    return null;
  }

  wiringHealth.attempts++;
  wiringHealth.lastProblems = res.problems;

  // Anything transient is worth another look before bothering anyone.
  const st = installer.status(RUNTIME);
  const shaky = [st.claude_code, st.desktop, st.hook].filter((s) => s && s.transient);
  wiringHealth.diagnosis = shaky.length ? shaky[0].diagnosis : null;

  if (!shaky.length) {
    wiringHealth.settled = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    for (const p of res.problems) console.error('[boardroom] wiring:', p);
    return res;
  }

  if (scheduleRetries && retriesLeft > 0) {
    const delay = RETRY_DELAYS[RETRY_DELAYS.length - retriesLeft];
    retriesLeft--;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => rewireQuietly(), delay);
    console.error(
      `[boardroom] a Claude config was briefly unreadable; rechecking in ${delay / 1000}s ` +
        `(${retriesLeft} attempts left). First missing: ${
          wiringHealth.diagnosis ? wiringHealth.diagnosis.firstMissing : 'unknown'
        }`
    );
  } else {
    // Out of retries: this is no longer a blip, so let it surface.
    wiringHealth.settled = true;
    console.error('[boardroom] config still unreadable after retries:', JSON.stringify(wiringHealth.diagnosis));
  }
  return res;
}

function createWindow(show = true) {
  if (win) {
    if (show) {
      win.show();
      win.focus();
      rewireQuietly();
    }
    return win;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show,
    backgroundColor: '#14161a',
    title: 'Claude Boardroom',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadURL(serverUrl);

  // Keep the app running in the tray when the window is closed, so the UI
  // server stays up and Begin Turn keeps working.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));

  // Anything that is not our own page opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function refreshTray() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const updateLabel =
    updateState.status === 'ready'
      ? `Restart to install ${updateState.version}`
      : updateState.status === 'downloading'
        ? `Downloading update… ${updateState.percent}%`
        : 'Check for Updates';

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Claude Boardroom ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Boardroom', click: () => createWindow(true) },
      {
        label: updateLabel,
        click: () =>
          updateState.status === 'ready' ? bridge.installUpdate() : bridge.checkUpdate(),
      },
      { type: 'separator' },
      {
        label: 'Start at Login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => bridge.setAutoStart({ enabled: item.checked }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.setToolTip(
    updateState.status === 'ready'
      ? `Claude Boardroom — update ${updateState.version} ready`
      : `Claude Boardroom ${app.getVersion()}`
  );
}

/* ---------------------------------------------------------------------- boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow(true));

  app.whenReady().then(async () => {
    ui.setRuntime(RUNTIME);
    ui.setBridge(bridge);

    // Self-heal Claude's config on every launch. After an update this is what
    // keeps the MCP entry and hook shim pointing at the current install
    // without the user re-running anything. It also runs whenever the window
    // is shown, which is the escape hatch for the post-update launch that
    // cannot read Claude's config.
    rewireQuietly();

    try {
      ({ url: serverUrl } = await ui.listen());
    } catch (err) {
      dialog.showErrorBox('Claude Boardroom', `Could not start the local UI server:\n\n${err.message}`);
      app.quit();
      return;
    }

    const img = nativeImage.createFromPath(iconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.on('click', () => createWindow(true));
    refreshTray();
    setInterval(refreshTray, 5000);

    // `--hidden` is passed by the login-item registration.
    const hidden = process.argv.includes('--hidden');
    createWindow(!hidden);

    initUpdater();
  });

  // Tray apps outlive their windows.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => (quitting = true));
}
