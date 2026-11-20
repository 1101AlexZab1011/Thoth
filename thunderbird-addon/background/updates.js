// Updates, the same on Linux, Windows and macOS: Thoth asks GitHub for its latest release (a tag
// like v2.15.0 whose release carries agent-chat.xpi, built by .github/workflows/release.yml), and when
// that is newer than the running version it says so: a system notification, a dot on the ☰ button
// with "Install update" in its menu, and Settings → Updates. Installing hands the release's file to
// Thunderbird's add-on manager, which replaces the running version. Nothing about the user is sent:
// one unauthenticated request to the public GitHub API.

export const UPDATE_REPO = "1101AlexZab1011/Thoth";
const ASSET = "agent-chat.xpi";
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const FIRST_CHECK = 60 * 1000;
const NOTIFICATION = "thoth-update";

/** Compare dotted versions: 2.15.0 > 2.14.40. */
export function newer(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function settings() {
  const { updateAuto = true, updateSkipped = "" } = await browser.storage.local.get({ updateAuto: true, updateSkipped: "" }).catch(() => ({}));
  return { auto: updateAuto, skipped: updateSkipped };
}

/** The latest release: { version, url, notes, page } or null when there is none with the add-on. */
async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" }, cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json();
  const asset = (release.assets ?? []).find((a) => a.name === ASSET);
  if (!asset) return null;
  return { version: String(release.tag_name ?? "").replace(/^v/, ""), url: asset.browser_download_url, notes: String(release.body ?? "").slice(0, 2000), page: release.html_url, published: release.published_at };
}

/** Check now: the state for Settings ({ current, latest, available, checkedAt, error }). */
export async function checkForUpdates({ manual = false } = {}) {
  const current = browser.runtime.getManifest().version;
  const state = { current, checkedAt: new Date().toISOString() };
  try {
    const release = await latestRelease();
    state.latest = release;
    state.available = Boolean(release && newer(release.version, current));
  } catch (error) {
    state.error = error.message;
  }
  await browser.storage.local.set({ updateState: state }).catch(() => {});
  // The menu's "Install update" and the dot on ☰ follow the state.
  await browser.workspace.setUpdate(state.available ? { version: state.latest.version, url: state.latest.url } : null).catch(() => {});
  const { skipped } = await settings();
  if (state.available && (manual || skipped !== state.latest.version)) {
    await browser.notifications.create(NOTIFICATION, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/thoth.svg"),
      title: `Thoth ${state.latest.version} is available`,
      message: `You have ${current}. Open the ☰ menu or Settings → Updates to install it.`,
    }).catch(() => {});
  }
  return state;
}

/** Install the latest release (Thunderbird downloads and installs it; the add-on then restarts). */
export async function installUpdate() {
  const { updateState } = await browser.storage.local.get("updateState");
  const url = updateState?.latest?.url;
  if (!updateState?.available || !url) throw new Error("No update to install");
  return browser.workspace.installUpdate(url);
}

export async function skipUpdate() {
  const { updateState } = await browser.storage.local.get("updateState");
  if (updateState?.latest?.version) await browser.storage.local.set({ updateSkipped: updateState.latest.version });
}

let timer = 0;
export function startUpdates() {
  browser.notifications.onClicked.addListener((id) => { if (id === NOTIFICATION) void browser.runtime.openOptionsPage(); });
  const run = async () => { if ((await settings()).auto) await checkForUpdates().catch((error) => console.warn("Thoth: update check", error)); };
  setTimeout(() => { void run(); clearInterval(timer); timer = setInterval(() => void run(), CHECK_EVERY); }, FIRST_CHECK);
}
