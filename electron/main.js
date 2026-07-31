'use strict';

// The desktop shell around the boardroom. It owns three things the plain
// command-line UI cannot do: it keeps the UI server alive in the tray, it can
// open a native folder picker, and it updates itself.
//
// The MCP server is deliberately NOT run in here. Claude spawns its own copy
// per session over stdio; this process just shares the same SQLite file.

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');

const ui = require('../src/ui-server');
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

function createWindow(show = true) {
  if (win) {
    if (show) {
      win.show();
      win.focus();
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
    // without the user re-running anything.
    try {
      installer.apply(RUNTIME, {});
    } catch (err) {
      console.error('[boardroom] could not update Claude config:', err.message);
    }

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
