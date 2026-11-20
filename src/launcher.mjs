// Thoth's launcher: Thoth runs in Thunderbird, in a profile of its own, so starting Thoth always
// opens Thoth (never a bare Thunderbird) and a Thunderbird the user already has stays as it was.
//
// install: the profile (with Thoth's preferences and the add-on, enabled without asking), Thoth's
// icons for its windows, the pairing with listener-mcp, and a "Thoth" entry where apps are started:
//   Linux    ~/.local/share/applications/thoth.desktop (+ icons in ~/.local/share/icons)
//   Windows  Start menu and desktop shortcuts (Thoth.lnk)
//   macOS    ~/Applications/Thoth.app
// The entry starts Thunderbird directly on the profile; nothing else runs at launch.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { isMac, isWindows } from "./platform.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "assets", "brand");
export const ADDON_ID = "agent-chat@mail-mcp-workspace.local";
const RELEASE_XPI = "https://github.com/1101AlexZab1011/Thoth/releases/latest/download/agent-chat.xpi";
const WM_CLASS = "Thoth";
// Thoth's Windows taskbar identity (AppUserModelID). The add-on puts every Thoth window in this group
// (experiments/workspace/implementation.js, THOTH_APP_ID); the Start menu shortcut carries the same id,
// which is how the taskbar finds Thoth's name and icon instead of thunderbird.exe's.
export const THOTH_APP_ID = "Thoth.Workspace";
// Window ids Thunderbird looks up icons by (profile/chrome/icons/default/<id>.png|.ico).
const WINDOW_IDS = ["messengerWindow", "msgcomposeWindow", "messageWindow", "default"];

/** Where Thoth keeps its Thunderbird profile. */
export function thothDirs(env = process.env) {
  const home = homedir();
  const base = isWindows ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Thoth")
    : isMac ? join(home, "Library", "Application Support", "Thoth")
      : join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "thoth");
  return { base, profile: join(base, "Profile") };
}

// ---- Thunderbird -------------------------------------------------------------------------------

async function windowsAppPath(env) {
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const { stdout } = await run("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\thunderbird.exe`, "/ve"], { env, windowsHide: true });
      const path = stdout.match(/REG_SZ\s+(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
      if (path && existsSync(path)) return path;
    } catch { /* not registered there */ }
  }
  return null;
}

/** The Thunderbird to run: THOTH_THUNDERBIRD, else where it installs itself, else PATH. */
export async function findThunderbird(env = process.env) {
  if (env.THOTH_THUNDERBIRD) return env.THOTH_THUNDERBIRD;
  const home = homedir();
  const candidates = isWindows
    ? [await windowsAppPath(env), ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean).map((base) => join(base, "Mozilla Thunderbird", "thunderbird.exe"))]
    : isMac ? ["/Applications/Thunderbird.app/Contents/MacOS/thunderbird", join(home, "Applications", "Thunderbird.app", "Contents", "MacOS", "thunderbird")]
      : [...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "thunderbird")), "/usr/lib/thunderbird/thunderbird", "/usr/lib64/thunderbird/thunderbird", "/opt/thunderbird/thunderbird", join(home, ".local", "opt", "thunderbird", "thunderbird")];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const INSTALL_HINT = isWindows ? "winget install Mozilla.Thunderbird (or https://www.thunderbird.net)"
  : isMac ? "brew install --cask thunderbird (or https://www.thunderbird.net)"
    : "your distribution's thunderbird package, or https://www.thunderbird.net (Flatpak and Snap builds cannot use Thoth's profile)";

// ---- the profile -------------------------------------------------------------------------------

/** Thoth's preferences: the add-on enabled without asking, and none of Thunderbird's own extras. */
export function userJs(uuid) {
  const prefs = {
    // The add-on, from the profile's extensions folder, enabled at once; its origin fixed so it can be paired before it first runs.
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "xpinstall.signatures.required": false,
    "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: uuid }),
    // No start page, What's New, rights or donation notices, default-client question or in-app messages.
    "mailnews.start_page.enabled": false,
    "mailnews.start_page.override_url": "",
    "mailnews.start_page.welcome_url": "",
    "mail.rights.version": 1,
    "mail.shell.checkDefaultClient": false,
    "app.donation.eoy.version.viewed": 9999,
    "mail.inappnotifications.enabled": false,
    "browser.aboutwelcome.enabled": false,
    // Thunderbird stays behind Thoth: a profile without accounts is not a "first run", so its
    // "Welcome to Thunderbird" account hub never opens by itself (FirstRun.sys.mjs, messenger.js).
    "mail.provider.suppress_dialog_on_startup": true,
    "mail.accounthub.thundermail.enabled": false,
    // Thunderbird's own updates install quietly, without "Restart to update Thunderbird" prompts.
    "app.update.suppressPrompts": true,
    // No data collection for Mozilla.
    "datareporting.policy.dataSubmissionEnabled": false,
    "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
    "datareporting.healthreport.uploadEnabled": false,
    "toolkit.telemetry.enabled": false,
    // Its own taskbar group on Windows, apart from a Thunderbird the user runs too.
    "taskbar.grouping.useprofile": true,
  };
  const lines = Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  return `// Written by Thoth's installer (npm run thoth:install); it is rewritten on every install.\n${lines.join("\n")}\n`;
}

export async function profileUuid(profile) {
  try {
    const text = await readFile(join(profile, "user.js"), "utf8");
    const json = text.match(/"extensions\.webextensions\.uuids", "(.+)"\);/)?.[1];
    const uuid = json && JSON.parse(JSON.parse(`"${json}"`))[ADDON_ID];
    if (uuid) return uuid;
  } catch { /* a new profile */ }
  return randomUUID();
}

/** The add-on file: dist/agent-chat.xpi when built here, else the latest release. */
async function addonFile(dest) {
  // On Windows a running Thoth keeps its add-on file open, and replacing it fails with EBUSY/EPERM
  // (or "UNKNOWN"): say what to do instead.
  const busy = (error) => {
    if (isWindows && ["EBUSY", "EPERM", "UNKNOWN"].includes(error.code)) throw new Error("Thoth is running and holds its add-on file. Quit Thoth (☰ → Quit), then run npm run thoth:install again");
    throw error;
  };
  const local = join(root, "dist", "agent-chat.xpi");
  if (existsSync(local)) { await copyFile(local, dest).catch(busy); return "dist/agent-chat.xpi"; }
  const response = await fetch(RELEASE_XPI);
  if (!response.ok) throw new Error(`Could not download the add-on (${response.status}); run npm run chat:addon first`);
  await writeFile(dest, Buffer.from(await response.arrayBuffer())).catch(busy);
  return RELEASE_XPI;
}

// ---- icons -------------------------------------------------------------------------------------

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const png = (size) => join(brand, `thoth-${size}.png`);

/** The pixels of an 8-bit RGBA, non-interlaced PNG (Thoth's own icons): { width, height, rgba }. */
export function decodePng(data) {
  if (data.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG");
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (data[24] !== 8 || data[25] !== 6 || data[28] !== 0) throw new Error("only 8-bit RGBA, non-interlaced PNGs");
  const idat = [];
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at), type = data.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat.push(data.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4, rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0, b = y ? rgba[(y - 1) * stride + x] : 0, c = x >= 4 && y ? rgba[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      rgba[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

/** An icon image as a bitmap (DIB): 32-bit BGRA rows bottom-up, then an all-clear AND mask. */
function dibImage({ width, height, rgba }) {
  const maskStride = Math.ceil(width / 32) * 4;
  const out = Buffer.alloc(40 + width * height * 4 + maskStride * height);
  out.writeUInt32LE(40, 0); out.writeInt32LE(width, 4); out.writeInt32LE(height * 2, 8);
  out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14); out.writeUInt32LE(width * height * 4 + maskStride * height, 20);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4, to = 40 + ((height - 1 - y) * width + x) * 4;
      out[to] = rgba[from + 2]; out[to + 1] = rgba[from + 1]; out[to + 2] = rgba[from]; out[to + 3] = rgba[from + 3];
    }
  }
  return out;
}

/** A Windows .ico as Windows' own are: bitmaps up to 128 px, PNG at 256 px; every part of the shell reads it. */
export async function writeIco(file, sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const images = await Promise.all(sizes.map(async (s) => { const data = await readFile(png(s)); return s >= 256 ? data : dibImage(decodePng(data)); }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((data, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], at); header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], at + 1);
    header.writeUInt8(0, at + 2); header.writeUInt8(0, at + 3); header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  const ico = Buffer.concat([header, ...images]);
  await writeFile(file, ico);
  return ico;
}

/** A macOS .icns of PNG images. */
export async function writeIcns(file) {
  const types = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512]];
  const chunks = await Promise.all(types.map(async ([type, size]) => {
    const data = await readFile(png(size));
    const head = Buffer.alloc(8); head.write(type, 0, "ascii"); head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  }));
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8); head.write("icns", 0, "ascii"); head.writeUInt32BE(body.length + 8, 4);
  await writeFile(file, Buffer.concat([head, body]));
}

/** Thoth's icon on its own windows: Thunderbird looks in the profile's chrome/icons/default first. */
async function windowIcons(profile) {
  const dir = join(profile, "chrome", "icons", "default");
  await mkdir(dir, { recursive: true });
  for (const id of WINDOW_IDS) {
    if (isWindows) await writeIco(join(dir, `${id}.ico`));
    else {
      await copyFile(png(256), join(dir, `${id}.png`));
      for (const size of [16, 32, 48, 64, 128, 256]) await copyFile(png(size), join(dir, `${id}${size}.png`));
    }
  }
}

// ---- where apps are started --------------------------------------------------------------------

const quote = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

async function linuxEntry(thunderbird, profile, env) {
  const data = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  for (const size of PNG_SIZES) {
    const dir = join(data, "icons", "hicolor", `${size}x${size}`, "apps");
    await mkdir(dir, { recursive: true });
    await copyFile(png(size), join(dir, "thoth.png"));
  }
  const scalable = join(data, "icons", "hicolor", "scalable", "apps");
  await mkdir(scalable, { recursive: true });
  await copyFile(join(brand, "thoth.svg"), join(scalable, "thoth.svg"));
  const file = join(data, "applications", "thoth.desktop");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, [
    "[Desktop Entry]", "Type=Application", "Name=Thoth", "GenericName=Workspace",
    "Comment=Mail, calendar, tasks, documents and an AI agent in one workspace",
    `Exec=${quote(thunderbird)} --profile ${quote(profile)} --class ${WM_CLASS} --name ${WM_CLASS} %u`,
    "Icon=thoth", `StartupWMClass=${WM_CLASS}`, "Terminal=false", "StartupNotify=true",
    "Categories=Office;Network;Email;Calendar;", "MimeType=x-scheme-handler/mailto;", "",
  ].join("\n"));
  await run("update-desktop-database", [dirname(file)]).catch(() => {});
  await run("gtk-update-icon-cache", ["-f", "-t", join(data, "icons", "hicolor")]).catch(() => {});
  return [file];
}

// Sets a shortcut's System.AppUserModel.ID (WScript.Shell cannot): its property store, read-write.
const SET_APP_ID = `
using System;
using System.Runtime.InteropServices;
public static class ThothShortcut {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid FormatId; public uint PropertyId; }
  [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort Type; ushort R1, R2, R3; public IntPtr Value; IntPtr Value2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint count); int GetAt(uint index, out PropertyKey key);
    int GetValue(ref PropertyKey key, out PropVariant value); int SetValue(ref PropertyKey key, ref PropVariant value); int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindContext, int flags, ref Guid iid, out IPropertyStore store);
  public static void SetAppId(string lnk, string id) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(lnk, IntPtr.Zero, 2, ref iid, out store));
    PropertyKey key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
    PropVariant value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(id) };
    try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); Marshal.ThrowExceptionForHR(store.Commit()); }
    finally { Marshal.FreeCoTaskMem(value.Value); Marshal.ReleaseComObject(store); }
  }
}`;

/** The PowerShell that writes Thoth's shortcuts: target, icon, and the taskbar id Thoth's windows use. */
export function windowsShortcutScript({ thunderbird, profile, ico, links }) {
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [`Add-Type -TypeDefinition ${ps(SET_APP_ID)}`, ...links.map((lnk) => [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${ps(lnk)})`,
    `$s.TargetPath = ${ps(thunderbird)}`,
    `$s.Arguments = ${ps(`--profile "${profile}"`)}`,
    `$s.WorkingDirectory = ${ps(dirname(thunderbird))}`,
    `$s.IconLocation = ${ps(`${ico},0`)}`,
    `$s.Description = 'Thoth: mail, calendar, documents and an AI agent'`,
    "$s.Save()",
    `[ThothShortcut]::SetAppId(${ps(lnk)}, ${ps(THOTH_APP_ID)})`,
  ].join("; "))].join("; ");
}

/** Where Windows keeps Thoth's shortcut icon (see windowsShortcuts). */
export const windowsIconDir = (env = process.env) => join(env.ProgramData ?? "C:\\ProgramData", "Thoth");

async function windowsShortcuts(thunderbird, profile, base, env) {
  // The icon lives in %ProgramData%\Thoth, which every user may create: the Windows 11 taskbar draws a
  // shortcut icon kept under the user's profile (%APPDATA%, %LOCALAPPDATA%) as a blank page, the same
  // file from ProgramData as it is. Its name carries a hash of its content, since Windows caches a
  // shortcut's icon by path. Without ProgramData it stays beside the profile.
  let dir = windowsIconDir(env);
  try { await mkdir(dir, { recursive: true }); } catch { dir = base; }
  const staging = join(dir, "thoth.ico.new");
  const hash = createHash("sha256").update(await writeIco(staging)).digest("hex").slice(0, 8);
  const ico = join(dir, `thoth-${hash}.ico`);
  for (const folder of new Set([dir, base])) {
    for (const old of await readdir(folder).catch(() => [])) if (/^thoth(-[0-9a-f]+)?\.ico$/.test(old) && join(folder, old) !== ico) await rm(join(folder, old), { force: true });
  }
  await rename(staging, ico);
  const startMenu = join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Thoth.lnk");
  const desktop = join(env.USERPROFILE ?? homedir(), "Desktop", "Thoth.lnk");
  const script = windowsShortcutScript({ thunderbird, profile, ico, links: [startMenu, desktop] });
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  return [startMenu, desktop];
}

async function macApp(thunderbird, profile) {
  const app = join(homedir(), "Applications", "Thoth.app");
  await rm(app, { recursive: true, force: true });
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeIcns(join(app, "Contents", "Resources", "thoth.icns"));
  await writeFile(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Thoth</string>
  <key>CFBundleDisplayName</key><string>Thoth</string>
  <key>CFBundleIdentifier</key><string>dev.thoth.launcher</string>
  <key>CFBundleExecutable</key><string>thoth</string>
  <key>CFBundleIconFile</key><string>thoth</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
</dict></plist>
`);
  const exe = join(app, "Contents", "MacOS", "thoth");
  await writeFile(exe, `#!/bin/sh\nexec ${quote(thunderbird)} --profile ${quote(profile)} "$@"\n`);
  await chmod(exe, 0o755);
  return [app];
}

// ---- pairing -----------------------------------------------------------------------------------

/** Pair the add-on's fixed origin with listener-mcp now; the add-on takes the pairing when it starts (10 minutes). */
async function pairAhead(uuid) {
  const { REQUIRED_SCOPES } = await import("../thunderbird-addon/shared/broker.js");
  const args = ["pair", "--name", "thoth", "--origin", `moz-extension://${uuid}`, "--scopes", REQUIRED_SCOPES.join(",")];
  try {
    const { stdout } = await run(isWindows ? "listener-mcp.cmd" : "listener-mcp", args, { windowsHide: true, shell: isWindows });
    return { paired: true, note: stdout.trim().split("\n").at(-1) };
  } catch (error) {
    return { paired: false, note: `listener-mcp pair failed (${error.message.split("\n")[0]}); pair later from Thoth's Settings → Agent connection` };
  }
}

// ---- install, launch, uninstall ----------------------------------------------------------------

export async function install({ env = process.env, launch: start = true, pair = true } = {}) {
  const thunderbird = await findThunderbird(env);
  if (!thunderbird) throw new Error(`Thunderbird is not installed. Install it first: ${INSTALL_HINT}`);
  const { base, profile } = thothDirs(env);
  await mkdir(join(profile, "extensions"), { recursive: true });
  const uuid = await profileUuid(profile);
  await writeFile(join(profile, "user.js"), userJs(uuid));
  const source = await addonFile(join(profile, "extensions", `${ADDON_ID}.xpi`));
  await windowIcons(profile);
  const entries = isWindows ? await windowsShortcuts(thunderbird, profile, base, env)
    : isMac ? await macApp(thunderbird, profile)
      : await linuxEntry(thunderbird, profile, env);
  const pairing = pair ? await pairAhead(uuid) : { paired: false, note: "skipped" };
  if (start) launch({ env, thunderbird });
  return { thunderbird, profile, addon: source, origin: `moz-extension://${uuid}`, entries, pairing, launched: start };
}

/** Start Thoth (Thunderbird on Thoth's profile), detached. */
export function launch({ env = process.env, thunderbird = null } = {}) {
  const { profile } = thothDirs(env);
  const exe = thunderbird ?? env.THOTH_THUNDERBIRD;
  const start = (path) => {
    const args = ["--profile", profile, ...(isWindows || isMac ? [] : ["--class", WM_CLASS, "--name", WM_CLASS])];
    spawn(path, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return { started: path, profile };
  };
  if (exe) return start(exe);
  return findThunderbird(env).then((found) => { if (!found) throw new Error("Thunderbird is not installed"); return start(found); });
}

export async function uninstall({ env = process.env, purge = false } = {}) {
  const { base, profile } = thothDirs(env);
  const removed = [];
  const drop = async (path) => { if (existsSync(path)) { await rm(path, { recursive: true, force: true }); removed.push(path); } };
  if (isWindows) {
    await drop(join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Thoth.lnk"));
    await drop(join(env.USERPROFILE ?? homedir(), "Desktop", "Thoth.lnk"));
    await drop(windowsIconDir(env)); // the shortcuts' icon
  } else if (isMac) await drop(join(homedir(), "Applications", "Thoth.app"));
  else {
    const data = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    await drop(join(data, "applications", "thoth.desktop"));
    for (const size of PNG_SIZES) await drop(join(data, "icons", "hicolor", `${size}x${size}`, "apps", "thoth.png"));
    await drop(join(data, "icons", "hicolor", "scalable", "apps", "thoth.svg"));
  }
  if (purge) await drop(base); // the profile too: its mail accounts, settings and local mail
  return { removed, kept: purge ? null : profile };
}
