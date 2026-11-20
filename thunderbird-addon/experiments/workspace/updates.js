/* Updates in the window: the ☰ button carries a dot and its menu an "Install update" item while a
   newer release is offered (background/updates.js finds it); installing hands the release's file to
   the add-on manager. Loaded into the Experiment's scope. */
/* global Services, ChromeUtils */

var updateOffer = null; // { version, url } or null

function setUpdateOffer(info, windows) {
  updateOffer = info && /^https:\/\/github\.com\/1101AlexZab1011\/Thoth\/releases\/download\//.test(String(info.url)) ? { version: String(info.version), url: String(info.url) } : null;
  for (const window of windows) window.document.getElementById("mw-appmenu-button")?.toggleAttribute("mw-update", Boolean(updateOffer));
  return { offered: Boolean(updateOffer) };
}

async function installThothUpdate(url) {
  // Only Thoth's own releases on GitHub.
  if (!/^https:\/\/github\.com\/1101AlexZab1011\/Thoth\/releases\/download\/[^/]+\/agent-chat\.xpi$/.test(String(url))) throw new Error("Not a Thoth release");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const install = await AddonManager.getInstallForURL(url, { telemetryInfo: { source: "thoth-update" } });
  const addon = await install.install();
  return { installed: addon?.version ?? null };
}
