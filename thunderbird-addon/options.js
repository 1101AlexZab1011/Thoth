import { PAIR_COMMAND, forgetToken, ensurePaired, host, json } from "./shared/broker.js";
import { APPEARANCES, setAppearance } from "./shared/theme.js";
import { dropdown, h } from "./shared/page.js";
import { DEFAULT_CODE_THEME } from "./viewer/code-theme.js";

const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
document.querySelector("#pair-command").textContent = PAIR_COMMAND(location.origin);
browser.storage.local.get({ listenerEndpoint: "http://127.0.0.1:47800", listenerToken: "" }).then((settings) => { endpoint.value = settings.listenerEndpoint; token.value = settings.listenerToken; });

function brokerOrigin() {
  const url = new URL(endpoint.value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Use http://127.0.0.1:<port>.");
  return url.origin;
}
document.querySelector("#save").addEventListener("click", async () => {
  try {
    if (!token.value) throw new Error("Enter a token, or use Pair now.");
    await browser.storage.local.set({ listenerEndpoint: brokerOrigin(), listenerToken: token.value, listenerScopesOk: false });
    status.textContent = "Saved.";
  } catch (error) { status.textContent = error.message; }
});
document.querySelector("#pair").addEventListener("click", async () => {
  try {
    await browser.storage.local.set({ listenerEndpoint: brokerOrigin() });
    await forgetToken();
    const paired = await ensurePaired();
    token.value = paired.token;
    status.textContent = "Paired.";
  } catch (error) { status.textContent = error instanceof TypeError ? "The broker is not reachable." : error.message; }
});

// ---- appearance
async function renderAppearance() {
  const { appearance } = await browser.storage.local.get({ appearance: "system" });
  document.querySelector("#appearance").replaceChildren(...APPEARANCES.map(([mode, label]) => h("button", {
    type: "button", role: "radio", "aria-checked": String(appearance === mode),
    onclick: async () => { await setAppearance(mode); await renderAppearance(); },
  }, label)));
}
void renderAppearance();

// ---- chat: 24-hour (the default) or 12-hour times
async function renderClock() {
  const { chatClock } = await browser.storage.local.get({ chatClock: "24" });
  document.querySelector("#clock").replaceChildren(...[["24", "24-hour (14:05)"], ["12", "12-hour (2:05 PM)"]].map(([value, label]) => h("button", {
    type: "button", role: "radio", "aria-checked": String(chatClock === value),
    onclick: async () => { await browser.storage.local.set({ chatClock: value }); await renderClock(); },
  }, label)));
}
void renderClock();

// ---- code theme, with a live preview
const SAMPLE = `// Fetch unread mail and group it by sender.
import { client } from "./mail";

export async function unreadBySender(folder: string): Promise<Map<string, number>> {
  const messages = await client.list(folder, { unread: true });
  const counts = new Map<string, number>();
  for (const { from } of messages) counts.set(from, (counts.get(from) ?? 0) + 1);
  return counts; // 3 senders, 12 messages
}`;

async function preview(theme) {
  const target = document.querySelector("#code-preview");
  try {
    const result = await host("/v1/highlight", json({ code: SAMPLE, lang: "typescript", theme }));
    target.innerHTML = result.html;
    target.style.background = result.bg;
  } catch (error) { target.textContent = `Preview unavailable: ${error.message}`; }
}

async function renderCodeTheme() {
  const { themes } = await fetch("http://127.0.0.1:47810/v1/code-themes").then((r) => r.json()).catch(() => ({ themes: [{ id: DEFAULT_CODE_THEME, name: "One Dark Pro" }] }));
  const { codeTheme } = await browser.storage.local.get({ codeTheme: DEFAULT_CODE_THEME });
  const picker = dropdown(themes.map((t) => [t.id, t.name]), codeTheme, async (id) => { await browser.storage.local.set({ codeTheme: id }); await preview(id); }, { label: "Code theme", width: 220 });
  document.querySelector("#code-theme").replaceChildren(picker);
  await preview(codeTheme);
}
void renderCodeTheme();

// ---- curated mail, writing and calendar settings (read and written through the add-on's allow-list)
const WEEKDAYS = [[1, "Monday"], [0, "Sunday"], [6, "Saturday"]];
const HOURS = Array.from({ length: 24 }, (_, hour) => [hour, `${String(hour).padStart(2, "0")}:00`]);
const SETTINGS = {
  mail: [
    { pref: "mail.threadpane.listview", label: "Message list", kind: "segmented", options: [[0, "Cards"], [1, "Table"]] },
    { pref: "mail.threadpane.cardsview.rowcount", label: "Lines per card", kind: "segmented", options: [[2, "2"], [3, "3"]] },
    { pref: "mailnews.mark_message_read.auto", label: "Mark messages as read when shown", kind: "switch" },
    { pref: "mailnews.mark_message_read.delay", label: "Only after a delay", hint: "Mark as read after the message has been shown for a few seconds.", kind: "switch", with: { pref: "mailnews.mark_message_read.delay.interval", unit: "s", min: 1, max: 60 } },
    { pref: "mailnews.message_display.disable_remote_image", label: "Block remote content", hint: "Images and other content loaded from the web, which can tell the sender you opened the message.", kind: "switch" },
    { pref: "mail.biff.show_alert", label: "Notify me of new mail", kind: "switch" },
    { pref: "mail.biff.play_sound", label: "Play a sound for new mail", kind: "switch" },
  ],
  writing: [
    { pref: "mail.spellcheck.inline", label: "Check spelling as I type", kind: "switch" },
    { pref: "mail.compose.autosave", label: "Save drafts automatically", kind: "switch", with: { pref: "mail.compose.autosaveinterval", unit: "min", min: 1, max: 60 } },
    { pref: "mail.collect_email_address_outgoing", label: "Add people I write to to my address book", kind: "switch" },
    { pref: "mail.warn_on_send_accel_key", label: "Confirm before sending with the keyboard", hint: "Ask before Ctrl+Enter sends a message.", kind: "switch" },
  ],
  calendar: [
    { pref: "calendar.week.start", label: "Week starts on", kind: "select", options: WEEKDAYS },
    { pref: "calendar.view-minimonth.showWeekNumber", label: "Show week numbers", kind: "switch" },
    { pref: "calendar.view.daystarthour", label: "Day starts at", kind: "select", options: HOURS },
    { pref: "calendar.view.dayendhour", label: "Day ends at", kind: "select", options: HOURS },
    { pref: "calendar.event.defaultlength", label: "New events last", kind: "select", options: [[15, "15 minutes"], [30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"], [90, "1½ hours"], [120, "2 hours"]] },
    { pref: "calendar.alarms.onforevents", label: "Remind me of new events", kind: "switch", on: 1, off: 0, with: { pref: "calendar.alarms.eventalarmlen", unit: "min before", min: 0, max: 10080 } },
    { pref: "calendar.alarms.playsound", label: "Play a sound for reminders", kind: "switch" },
  ],
};

async function renderSettings() {
  const prefs = Object.values(SETTINGS).flat().flatMap((s) => [s.pref, s.with?.pref].filter(Boolean));
  let values;
  try { values = await browser.workspace.getSettings(prefs); } catch (error) { values = null; console.warn("Settings unavailable:", error); }
  for (const [group, rows] of Object.entries(SETTINGS)) {
    const section = document.querySelector(`[data-settings="${group}"]`);
    if (!section) continue;
    section.querySelectorAll(".setting, .settings-unavailable").forEach((el) => el.remove());
    if (!values) { section.append(h("p.settings-unavailable", {}, "These settings can't be read right now.")); continue; }
    for (const row of rows) section.append(settingRow(row, values));
  }
}

function settingRow(row, values) {
  const save = async (pref, value) => { try { await browser.workspace.setSetting(pref, value); } catch (error) { console.warn(error); } await renderSettings(); };
  const value = values[row.pref];
  const control = h("div.setting-control");
  if (row.kind === "switch") {
    const on = row.on ?? true;
    const input = h("input.switch", { type: "checkbox", role: "switch", "aria-label": row.label, checked: value === on, onchange: (event) => void save(row.pref, event.target.checked ? on : (row.off ?? false)) });
    control.append(input);
  } else if (row.kind === "segmented") {
    control.append(h("div.segmented", { role: "radiogroup", "aria-label": row.label }, ...row.options.map(([v, label]) => h("button", { type: "button", role: "radio", "aria-checked": String(value === v), onclick: () => void save(row.pref, v) }, label))));
  } else if (row.kind === "select") {
    control.append(dropdown(row.options, value, (v) => void save(row.pref, Number(v)), { label: row.label, width: 140 }));
  }
  if (row.with) {
    const extra = values[row.with.pref];
    const input = h("input.input", { type: "number", min: row.with.min, max: row.with.max, value: extra ?? "", "aria-label": `${row.label} (${row.with.unit})`, disabled: row.kind === "switch" && value !== (row.on ?? true),
      onchange: (event) => { const n = Math.min(row.with.max, Math.max(row.with.min, Number(event.target.value) || row.with.min)); void save(row.with.pref, n); } });
    control.prepend(input, h("span.setting-hint", {}, row.with.unit));
  }
  return h("div.setting", {}, h("div.setting-label", {}, row.label), row.hint ? h("div.setting-hint", {}, row.hint) : null, control);
}
void renderSettings();

// ---- accounts, security, advanced: Thunderbird's own dialogs and pages
const actionButton = (label, action, primary) => h(`button.btn${primary ? ".primary" : ""}`, { type: "button", onclick: () => void browser.workspace.settingsAction(action).catch((error) => console.warn(error)) }, label);
document.querySelector("#account-actions").replaceChildren(
  actionButton("Account settings", "accounts", true), actionButton("Add a mail account", "add-mail"), actionButton("Add a calendar", "add-calendar"),
  actionButton("Add an address book", "add-addressbook"), actionButton("Encryption keys", "keys"), actionButton("Saved passwords", "passwords"), actionButton("Message filters", "filters"));
document.querySelector("#advanced-actions").replaceChildren(actionButton("Advanced settings", "advanced"), actionButton("Configuration editor", "config"));

// ---- the section list follows the scroll
const tocLinks = [...document.querySelectorAll("nav.toc a")];
const spy = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) for (const link of tocLinks) link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
}, { rootMargin: "-10% 0px -80% 0px" });
for (const section of document.querySelectorAll("main > section")) spy.observe(section);
