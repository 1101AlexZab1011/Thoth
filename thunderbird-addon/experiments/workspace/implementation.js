/* Thoth Experiment: the privileged half of the add-on. Layout lives in
   layout.js (the space bar's tool groups in groups.js, the Browser and its sessions in web.js, its menu in webmenu.js), GUI state and automation in automation.js; all are loaded into
   this scope so they share helpers without globals leaking into Thunderbird. */
/* global ExtensionAPI */
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
var { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");

const MESSENGER = "chrome://messenger/content/messenger.xhtml";
const RESOURCE_HOST = "mailworkspace";
// Thoth's Windows taskbar identity (AppUserModelID). The launcher (src/launcher.mjs, THOTH_APP_ID)
// stamps the same id on the Thoth shortcuts, so the taskbar shows Thoth's name and icon, not Thunderbird's.
const THOTH_APP_ID = "Thoth.Workspace";

var workspace = class extends ExtensionAPI {
  onStartup() {
    const resProto = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    resProto.setSubstitutionWithFlags(RESOURCE_HOST, this.extension.rootURI, resProto.ALLOW_CONTENT_ACCESS);
    this.scope = { Services, ChromeUtils, Ci, Cc, Cu, ExtensionParent, IOUtils, PathUtils, console };
    for (const file of ["address.js", "shortcuts.js", "websessions.js", "webhistory.js", "layout.js", "shell.js", "groups.js", "calendar.js", "tasks.js", "mail.js", "web.js", "webmenu.js", "appmenu.js", "updates.js", "settings.js", "aboutlogins.js", "automation.js"]) {
      // Through resource://, which is trusted also when the add-on runs from a folder.
      Services.scriptloader.loadSubScript(`resource://${RESOURCE_HOST}/experiments/workspace/${file}?${Date.now()}`, this.scope);
    }
    // The Browser's saved passwords page; registered before windows restore a tab showing it.
    this.undoAboutLogins = this.scope.installAboutLogins(this.extension.rootURI, Components.manager);
    this.listeners = { dock: new Set(), shortcut: new Set() };
    this.sheetUrl = `resource://${RESOURCE_HOST}/theme/chrome.css`;
    this.paneSheetUrl = `resource://${RESOURCE_HOST}/theme/panes.css`;
    this.groupWindowsAsThoth();
  }

  /**
   * Windows: every Thoth window joins Thoth's taskbar group, which the Thoth shortcut names and gives
   * its icon, and carries Thoth's icon itself (title bar, Alt+Tab, the taskbar's window preview).
   */
  groupWindowsAsThoth() {
    if (Services.appinfo.OS !== "WINNT") return;
    let taskbar;
    try { taskbar = Cc["@mozilla.org/windows-taskbar;1"].getService(Ci.nsIWinTaskbar); } catch { return; }
    if (!taskbar.available) return;
    const keepIcon = this.windowIconKeeper();
    this.stopWindowIcons = () => keepIcon?.stopAll();
    // Also runs for the windows already open.
    ExtensionSupport.registerWindowListener(`${this.extension.id}-taskbar`, {
      onLoadWindow: (window) => {
        try { taskbar.setGroupIdForWindow(window, THOTH_APP_ID); } catch (error) { console.error("Thoth taskbar group failed", error); }
        try { keepIcon?.(window); } catch (error) { console.error("Thoth window icon failed", error); }
      },
    });
  }

  /**
   * A function that gives a window Thoth's icon and keeps it there, or null. Thunderbird takes window
   * icons only from its own install folder (chrome/icons/default), never from the profile, so the icon
   * the launcher writes into the profile (src/launcher.mjs, windowIcons) is handed to Thunderbird's
   * own WindowsUIUtils.setWindowIcon. Thunderbird still puts its own icon back at times (as it starts,
   * when the window frame changes), destroying the one it replaces, so each window is checked every
   * second and given a fresh copy of Thoth's. A window has one keeper: one left by an earlier run of
   * the add-on (an update reloads it in the open window) is stopped first.
   */
  windowIconKeeper() {
    let ctypes, image, uiUtils;
    try {
      ({ ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs"));
      const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      uiUtils = Cc["@mozilla.org/windows-ui-utils;1"].getService(Ci.nsIWindowsUIUtils);
      const file = new FileUtils.File(PathUtils.join(PathUtils.profileDir, "chrome", "icons", "default", "messengerWindow.ico"));
      if (!file.exists()) return null; // not installed by the launcher
      const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      stream.init(file, -1, 0, 0);
      const bytes = NetUtil.readInputStreamToString(stream, stream.available());
      stream.close();
      image = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromBuffer(bytes, bytes.length, "image/x-icon");
    } catch (error) { console.error("Thoth window icon unavailable", error); return null; }
    const user32 = ctypes.open("user32.dll");
    const SendMessageW = user32.declare("SendMessageW", ctypes.winapi_abi, ctypes.intptr_t, ctypes.voidptr_t, ctypes.uint32_t, ctypes.uintptr_t, ctypes.voidptr_t);
    const [WM_GETICON, ICON_SMALL, ICON_BIG] = [0x7f, 0, 1];
    const keepers = new Set();
    const keep = (window) => {
      window.thothIconKeeper?.stop();
      const handle = window.docShell?.treeOwner?.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
      if (!handle) return;
      const hwnd = ctypes.voidptr_t(ctypes.UInt64(handle));
      const shown = () => `${SendMessageW(hwnd, WM_GETICON, ICON_SMALL, null)}/${SendMessageW(hwnd, WM_GETICON, ICON_BIG, null)}`;
      let ours;
      const apply = () => { uiUtils.setWindowIcon(window, image, image); ours = shown(); };
      const timer = window.setInterval(() => { try { if (shown() !== ours) apply(); } catch { /* window closing */ } }, 1000);
      const keeper = {
        stop() {
          window.clearInterval(timer);
          keepers.delete(keeper);
          if (window.thothIconKeeper === keeper) delete window.thothIconKeeper;
        },
      };
      keepers.add(keeper);
      window.thothIconKeeper = keeper;
      window.addEventListener("unload", () => keeper.stop(), { once: true });
      apply();
    };
    keep.stopAll = () => { for (const keeper of [...keepers]) keeper.stop(); user32.close(); };
    return keep;
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    ExtensionSupport.unregisterWindowListener(`${this.extension.id}-taskbar`);
    this.stopWindowIcons?.();
    this.undoAboutLogins?.();
    ExtensionSupport.unregisterWindowListener(`${this.extension.id}-workspace`);
    this.scope?.removeTheme?.(this.paneSheetUrl);
    for (const window of ExtensionSupport.openWindows) {
      if (window.location.href === MESSENGER) this.scope?.removeLayout?.(window, this.sheetUrl);
    }
    Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution(RESOURCE_HOST, null);
    // Our subscripts may be cached; a reload must pick up the new files.
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }

  messengerWindows() {
    return [...ExtensionSupport.openWindows].filter((window) => window.location.href === MESSENGER && window.document.readyState !== "uninitialized");
  }

  mainWindow() {
    return Services.wm.getMostRecentWindow("mail:3pane");
  }

  getAPI(context) {
    const self = this;
    const scope = this.scope;

    const emitDock = (dock) => { for (const listener of self.listeners.dock) listener(dock); };
    const update = (side, change) => {
      const dock = scope.readDock(side);
      if (change.state === "toggle") dock.state = dock.state === "open" ? "minimized" : "open";
      else if (change.state) dock.state = change.state;
      if (Number.isInteger(change.width)) dock.width = Math.max(scope.MIN_WIDTH, change.width);
      // Maximizing one dock takes the whole area, so the other one cannot also be maximized.
      if (dock.state === "maximized") {
        const other = scope.readDock(side === "left" ? "right" : "left");
        if (other.state === "maximized") { other.state = "open"; scope.writeDock(other); for (const w of self.messengerWindows()) scope.applyDock(w, other); emitDock(other); }
      }
      scope.writeDock(dock);
      for (const window of self.messengerWindows()) {
        scope.forgetAuto(window, `dock:${side}`);
        scope.applyDock(window, dock);
        // Opening or widening a dock may need room: the space manager makes it.
        if (dock.state === "open") dock.width = scope.fit(window, { side, width: dock.width }, (d) => emitDock(d));
        scope.markSidebar(window, self.filesSide);
      }
      scope.writeDock(dock);
      for (const window of self.messengerWindows()) scope.applyDock(window, dock);
      emitDock(dock);
      return dock;
    };

    const spaceButtonPrefix = () => `${ExtensionCommon.makeWidgetId(self.extension.id)}-spacesButton-`;

    const api = {
      workspace: {
        async install({ leftUrl, rightUrl, filesSide = "left", terminalUrl }) {
          self.filesSide = filesSide;
          // Before any window is laid out: registering the window listener below
          // already applies the layout to open windows.
          scope.migrateDockPrefs();
          const ctx = {
            extension: self.extension,
            leftUrl,
            rightUrl,
            terminalUrl,
            sheetUrl: self.sheetUrl,
            update,
            filesSide,
            notify: (dock) => emitDock(dock),
            shortcut: (name) => { for (const listener of self.listeners.shortcut) listener(name); },
          };
          const apply = (window) => {
            const run = () => { try { scope.applyLayout(window, ctx); } catch (error) { console.error("Thoth layout failed", error); } };
            if (window.document.getElementById("tabmail")) run();
            else window.addEventListener("load", run, { once: true });
          };
          ExtensionSupport.registerWindowListener(`${self.extension.id}-workspace`, { chromeURLs: [MESSENGER], onLoadWindow: apply });
          for (const window of self.messengerWindows()) apply(window);
          scope.installTheme(self.paneSheetUrl, self.messengerWindows());
          scope.preparePrefs();
          return true;
        },
        async getDocks() { return [scope.readDock("left"), scope.readDock("right")]; },
        async setDock(side, change) { return update(side, change); },
        async openSpace(name) { return scope.openSpace(self.mainWindow(), name); },
        async getState() { return scope.getState(self.mainWindow(), [scope.readDock("left"), scope.readDock("right")]); },
        // The schema passes an omitted optional argument as null, which a default
        // parameter does not replace, so null options are normalised here.
        async snapshot(options) { return scope.snapshot(self.mainWindow(), options ?? {}); },
        async act(ref, action, value, options) { return scope.act(self.mainWindow(), ref, action, value, options ?? {}); },
        // A space of ours can be on record while its button is gone (after an add-on reload); a new space
        // of that name is then refused or never shown. The background asks after each space it installs.
        async spaceShown(name) {
          const id = `${spaceButtonPrefix()}${name}`;
          const window = self.mainWindow();
          // Only once the window and its toolbar are up: during startup a restored button is not there yet.
          for (let i = 0; i < 50 && !(window?.document.readyState === "complete" && window.gSpacesToolbar?.isLoaded !== false); i++) await new Promise((r) => setTimeout(r, 100));
          if (!window?.gSpacesToolbar) return true;
          return Boolean(window.document.getElementById(id)?.isConnected);
        },
        async dropSpace(name) {
          const id = `${spaceButtonPrefix()}${name}`;
          for (const window of self.messengerWindows()) {
            const bar = window.gSpacesToolbar;
            if (bar?.spaces) bar.spaces = bar.spaces.filter((space) => space.name !== id);
            window.document.getElementById(id)?.remove();
            window.document.getElementById(`${id}-menuitem`)?.remove();
          }
          const tracker = ExtensionParent.apiManager.global.spaceTracker;
          const data = tracker?._spaceData?.get(id);
          if (data) { tracker._spaceData.delete(id); tracker._spaceIds?.delete(data.spaceId); }
          return true;
        },
        async pressKey(combo, options) { return scope.pressKey(self.mainWindow(), combo, options ?? {}); },
        async screenshot(options) { return scope.screenshot(self.mainWindow(), options ?? {}); },
        async selectMail(folderUri, messageKeys) { return scope.selectMail(self.mainWindow(), folderUri, messageKeys); },
        async calendarGoto(date, view) { return scope.calendarGoto(self.mainWindow(), date, view); },
        async setTerminal(change) { const window = self.mainWindow(); return scope.setTerminal(window, window.mwCtx, change); },
        async getTerminal() { return scope.terminalState(self.mainWindow()); },
        async openWeb(input, options) { return scope.openWeb(self.mainWindow(), input ?? "", options ?? {}); },
        async webState() { return scope.webState(self.mainWindow()); },
        async webDownloads() { return scope.webDownloads(); },
        async offerLogin(tabId, data) { return scope.offerLogin(self.mainWindow(), tabId, data ?? {}); },
        async webSession(action, name, newName) { return scope.webSession(self.mainWindow(), action, name ?? "", newName ?? ""); },
        async webNavigate(action) { return scope.webNavigate(self.mainWindow(), action); },
        async webClick(x, y) { return scope.webClick(self.mainWindow(), x, y); },
        async setAppearance(mode) { return scope.setAppearance(mode, self.messengerWindows()); },
        async pickPath(options) { return pickPath(self.mainWindow(), options ?? {}); },
        async setUpdate(info) { return scope.setUpdateOffer(info ?? null, self.messengerWindows()); },
        async installUpdate(url) { return scope.installThothUpdate(url); },
        async readFile(path) {
          const file = String(path).replace(/^~(?=\/|$)/, Services.dirsvc.get("Home", Ci.nsIFile).path);
          const info = await IOUtils.stat(file);
          if (info.type !== "regular") throw new Error("Not a file");
          if (info.size > 100 * 1024 * 1024) throw new Error(`${PathUtils.filename(file)} is larger than 100 MB`);
          const bytes = await IOUtils.read(file);
          return { base64: toBase64(bytes), size: info.size };
        },
        async getSettings(names) { return scope.getSettings(names ?? null); },
        async setSetting(name, value) { return scope.setSetting(name, value); },
        async settingsAction(action) { return scope.settingsAction(self.mainWindow(), action); },
        async focusOwnTab() { for (const window of self.messengerWindows()) scope.markTabs(window, self.extension); return true; },
        onDockChanged: new ExtensionCommon.EventManager({
          context,
          name: "workspace.onDockChanged",
          register(fire) {
            const listener = (dock) => fire.async(dock);
            self.listeners.dock.add(listener);
            return () => self.listeners.dock.delete(listener);
          },
        }).api(),
        onShortcut: new ExtensionCommon.EventManager({
          context,
          name: "workspace.onShortcut",
          register(fire) {
            const listener = (name) => fire.async(name);
            self.listeners.shortcut.add(listener);
            return () => self.listeners.shortcut.delete(listener);
          },
        }).api(),
      },
    };
    // A plain Error reaches the add-on's pages only as "An unexpected error occurred"; its message (why a
    // control is the user's, a stale ref) is what the agent needs, so every method passes it on.
    for (const [name, method] of Object.entries(api.workspace)) {
      if (typeof method !== "function") continue;
      api.workspace[name] = async (...args) => {
        try { return await method(...args); } catch (error) {
          throw error instanceof ExtensionUtils.ExtensionError ? error : new ExtensionUtils.ExtensionError(error?.message ?? String(error));
        }
      };
    }
    return api;
  }
};

/**
 * The system's file chooser over Thunderbird's window: a folder ("folder"), a file to open ("open")
 * or a file to save ("save"), starting in `path` (~ is the home folder). Resolves to the chosen
 * path, or null when cancelled.
 */
/**
 * Linux: GTK opens its file chooser at the size it saved last time. Under a tiling window manager
 * that is the whole screen (once tiled, the size is saved and comes back even when floating), so a
 * saved size larger than the screen is put back to 70% of it before the chooser opens.
 */
async function fitGtkChooser(window) {
  if (Services.appinfo.OS !== "Linux") return;
  try {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const gsettings = await Subprocess.pathSearch("gsettings").catch(() => null);
    if (!gsettings) return;
    const read = await Subprocess.call({ command: gsettings, arguments: ["get", "org.gtk.Settings.FileChooser", "window-size"] });
    const text = await read.stdout.readString();
    await read.wait();
    const [w, h] = (text.match(/-?\d+/g) ?? []).map(Number);
    // GTK saves device pixels; the window's screen is in CSS pixels.
    const sw = window.screen.availWidth * window.devicePixelRatio;
    const sh = window.screen.availHeight * window.devicePixelRatio;
    if (!(w > sw * 0.9 || h > sh * 0.9)) return;
    const fixed = `(${Math.round(sw * 0.7)}, ${Math.round(sh * 0.7)})`;
    const write = await Subprocess.call({ command: gsettings, arguments: ["set", "org.gtk.Settings.FileChooser", "window-size", fixed] });
    await write.wait();
  } catch (error) { console.warn("Thoth: file chooser size", error); }
}

async function pickPath(window, options = {}) {
  await fitGtkChooser(window);
  return pickPathNow(window, options);
}

function pickPathNow(window, { mode = "folder", title = "", path = "", filter = "all", read = false, multiple = false } = {}) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  const modes = { folder: Ci.nsIFilePicker.modeGetFolder, open: Ci.nsIFilePicker.modeOpen, save: Ci.nsIFilePicker.modeSave };
  picker.init(window.browsingContext, title || (mode === "folder" ? "Choose a folder" : multiple ? "Choose files" : "Choose a file"), mode === "open" && multiple ? Ci.nsIFilePicker.modeOpenMultiple : modes[mode] ?? modes.folder);
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const full = String(path || "").replace(/^~(?=\/|$)/, home);
  try {
    let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(full || home);
    while (dir && !(dir.exists() && dir.isDirectory())) dir = dir.parent;
    if (dir) picker.displayDirectory = dir;
  } catch { /* start wherever the chooser likes */ }
  if (mode === "save" && full) picker.defaultString = full.split("/").pop();
  if (mode !== "folder" && filter === "images") picker.appendFilters(Ci.nsIFilePicker.filterImages);
  if (mode !== "folder") picker.appendFilters(Ci.nsIFilePicker.filterAll);
  const chosenPaths = () => {
    if (!(mode === "open" && multiple)) return picker.file?.path ? [picker.file.path] : [];
    const out = [];
    const files = picker.files;
    while (files.hasMoreElements()) out.push(files.getNext().QueryInterface(Ci.nsIFile).path);
    return out;
  };
  return new Promise((resolve) => picker.open((result) => resolve(result === Ci.nsIFilePicker.returnCancel ? null : chosenPaths())))
    .then(async (chosen) => {
      if (!chosen?.length) return null;
      if (!read) return multiple ? chosen : chosen[0];
      // The files' bytes for the page (an image for a document, a chat attachment), up to 100 MB each.
      const readOne = async (file) => {
        const info = await IOUtils.stat(file);
        if (info.size > 100 * 1024 * 1024) throw new Error(`${PathUtils.filename(file)} is larger than 100 MB`);
        const bytes = await IOUtils.read(file);
        return { path: file.replaceAll("\\", "/"), name: PathUtils.filename(file), base64: toBase64(bytes) };
      };
      const all = await Promise.all(chosen.map(readOne));
      return multiple ? all : all[0];
    });
}

/** Standard base64 of bytes (the Experiment's scope has no btoa). */
function toBase64(bytes) {
  return ChromeUtils.base64URLEncode(bytes, { pad: true }).replace(/-/g, "+").replace(/_/g, "/");
}
