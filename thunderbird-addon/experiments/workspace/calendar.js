/* The calendar tab, redesigned after the user's reference (a Google-Calendar-like layout) on top of
   Thunderbird's own calendar, so sync, reminders and editing stay Thunderbird's:
   - a top bar: Today, ‹ ›, the range, Day / Week / Month / Agenda, search;
   - a left column: New event ▾, the month (a dot under busy days), My calendars with coloured
     checkboxes, Tags (the user's calendar categories with their colours, and + to add one);
   - the week: day headings as weekday over a large date, today as a blue badge, events as pale cards
     with a coloured bar, their time and reminder/attendee icons;
   - an event details panel on the right while an event is selected;
   - an Agenda view: the coming events grouped by day.
   Loaded into the experiment's scope (see implementation.js); installCalendar() returns its undo. */
/* global Services, Ci, ChromeUtils */

const CAL_SHEET = "resource://mailworkspace/theme/calendar.css";
// Colours for tags added with "+", in turn (the user's own tags; none are built in).
const CAL_TAG_COLORS = ["#4557d6", "#8e6bd8", "#1b9e8f", "#d65a5a", "#d99a1e", "#4f9d55", "#c45cb8", "#3a91c8", "#a8875a"];
const XHTML_NS = "http://www.w3.org/1999/xhtml";

function installCalendar(window) {
  const document = window.document;
  const panel = document.getElementById("calendarTabPanel");
  const cal = window.cal;
  if (!panel || !cal) return () => {};
  window.windowUtils.loadSheetUsingURIString(CAL_SHEET, window.windowUtils.AUTHOR_SHEET);
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(XHTML_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "onclick") node.addEventListener("click", value);
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  };
  const added = []; // nodes to remove on undo
  const add = (node) => { added.push(node); return node; };
  const undo = [];

  // --- top bar ------------------------------------------------------------------------------
  // Today as a labelled pill before ‹ › (Thunderbird's own is an icon; it does the work).
  const today = $("todayViewButton");
  const todayPill = add(el("button", { id: "mw-cal-today", type: "button", title: "Go to today", text: "Today" }));
  todayPill.addEventListener("click", () => today?.click());
  $("calendarControls")?.prepend(todayPill);
  const toggle = $("viewToggle");
  const agendaButton = add(el("button", { id: "mw-calTabAgenda", class: "calview-toggle-item", role: "tab", type: "button", "aria-selected": "false", title: "Switch to agenda view", text: "Agenda" }));
  toggle?.append(agendaButton);
  const search = add(el("button", { id: "mw-cal-search", class: "button button-flat icon-button icon-only", type: "button", title: "Search events" }));
  $("calendarControlBarMenu")?.before(search);
  search.addEventListener("click", () => {
    const on = !panel.hasAttribute("mw-search");
    panel.toggleAttribute("mw-search", on);
    if (on) window.setTimeout(() => $("unifinder-search-field")?.focus(), 50);
  });
  const interval = $("intervalDescription");
  // The range as the reference writes it: "Nov 22 – 28, 2026" (Thunderbird spells the month out).
  const shortRange = () => {
    if (!interval || interval.hasAttribute("mw-hidden")) return;
    const text = interval.textContent;
    const short = text.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, (m) => m.slice(0, 3));
    if (short !== text) interval.textContent = short;
  };
  // The month above the small calendar: "November 2026", from Thunderbird's own read-only heading.
  const minimonthTitle = () => {
    const header = document.querySelector("#calMinimonth .minimonth-header");
    const source = document.querySelector("#calMinimonth .minimonth-readonly-header");
    if (!header || !source) return;
    let title = header.querySelector(".mw-mm-title");
    if (!title) { title = add(el("span", { class: "mw-mm-title" })); header.prepend(title); }
    if (title.textContent !== source.textContent.trim()) title.textContent = source.textContent.trim();
  };

  // --- left column: New event ▾, My calendars +, Tags ------------------------------------------
  const newEvent = $("sidePanelNewEvent");
  const more = add(el("button", { id: "mw-new-event-more", type: "button", title: "More" }));
  newEvent?.after(more);
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(more, [["New event", () => newEvent.click()], ["New task", () => $("sidePanelNewTask")?.click()]]);
  });
  // The column scrolls as one: its panes keep their content's height (xul.css makes [flex="1"]
  // stretch with !important, which no author rule overrides, so the attribute goes while we run).
  const unflexed = ["calendar-panel", "calendar-list-pane", "calendar-list-inner-pane"].map($).filter((node) => node?.getAttribute("flex") === "1");
  for (const node of unflexed) node.removeAttribute("flex");
  undo.push(() => { for (const node of unflexed) node.setAttribute("flex", "1"); });
  const listLabel = $("calendar-list-header-label");
  const oldListLabel = listLabel?.textContent;
  if (listLabel) { listLabel.removeAttribute("data-l10n-id"); listLabel.textContent = "My calendars"; }
  const addCalendar = add(el("button", { id: "mw-cal-add", class: "mw-cal-plus", type: "button", title: "Add a calendar" }));
  $("calendarListHeader")?.after(addCalendar);
  addCalendar.addEventListener("click", () => window.goDoCommand("calendar_new_calendar_command"));

  const tags = add(el("div", { id: "mw-cal-tags" }));
  $("calendar-list-pane")?.after(tags);
  const TAGS_SHOWN = 8;
  const tagColor = (name) => Services.prefs.getStringPref(`calendar.category.color.${cal.view.formatStringForCSSRule(name)}`, "") || "#9aa3b2";
  let tagsOpen = false;
  let tagsUsed = new Map(); // tag -> number of events with it, a year back and forward
  async function countTags() {
    const now = Date.now();
    const tz = cal.dtz.defaultTimezone;
    const items = await cal.view.getCompositeCalendar(window).getItemsAsArray(Ci.calICalendar.ITEM_FILTER_TYPE_ALL, 0, cal.dtz.jsDateToDateTime(new Date(now - 365 * 86400000), tz), cal.dtz.jsDateToDateTime(new Date(now + 365 * 86400000), tz));
    const used = new Map();
    for (const item of items) for (const name of item.getCategories?.() ?? []) used.set(name, (used.get(name) ?? 0) + 1);
    tagsUsed = used;
    renderTags();
  }
  function renderTags() {
    const all = cal.category.fromPrefs();
    // Tags in use first (most used first), then the rest as the user ordered them.
    const names = all.map((name, index) => ({ name, index, used: tagsUsed.get(name) ?? 0 }))
      .sort((x, y) => (y.used > 0) - (x.used > 0) || y.used - x.used || x.index - y.index).map((t) => t.name);
    const plus = el("button", { class: "mw-cal-plus", type: "button", title: "Add a tag" });
    plus.addEventListener("click", () => {
      const result = { value: "" };
      if (!Services.prompt.prompt(window, "New tag", "Name of the tag:", result, null, {}) || !result.value.trim()) return;
      const list = cal.category.fromPrefs();
      if (!list.includes(result.value.trim())) list.push(result.value.trim());
      Services.prefs.setStringPref(`calendar.category.color.${cal.view.formatStringForCSSRule(result.value.trim())}`, CAL_TAG_COLORS[list.length % CAL_TAG_COLORS.length]);
      Services.prefs.setStringPref("calendar.categories.names", cal.category.arrayToString(list));
    });
    const visible = tagsOpen || names.length <= TAGS_SHOWN + 1 ? names : names.slice(0, TAGS_SHOWN);
    const items = visible.map((name) => el("li", { class: "mw-cal-tag", style: `--tag: ${tagColor(name)}`, title: tagsUsed.get(name) ? `${name} (${tagsUsed.get(name)})` : name }, el("span", { class: "mw-tag-icon" }), el("span", { class: "mw-tag-name", text: name })));
    let toggle = null;
    if (names.length > TAGS_SHOWN + 1) {
      toggle = el("button", { class: "mw-cal-more", type: "button", text: tagsOpen ? "Show fewer" : `Show all (${names.length})` });
      toggle.addEventListener("click", () => { tagsOpen = !tagsOpen; renderTags(); });
    }
    tags.replaceChildren(el("div", { class: "mw-cal-section-head" }, el("span", { text: "Tags" }), plus), el("ol", { class: "mw-cal-tag-list" }, ...items), toggle ?? "");
  }
  renderTags();
  void countTags().catch((error) => console.error("Thoth: tags", error));
  const prefObserver = { observe: () => renderTags() };
  Services.prefs.addObserver("calendar.categories.names", prefObserver);
  Services.prefs.addObserver("calendar.category.color.", prefObserver);
  undo.push(() => { Services.prefs.removeObserver("calendar.categories.names", prefObserver); Services.prefs.removeObserver("calendar.category.color.", prefObserver); });

  // Calendar checkboxes in the calendar's colour.
  function colorCheckboxes() {
    for (const item of document.querySelectorAll("#calendar-list > li")) {
      const color = item.querySelector(".calendar-color")?.style.backgroundColor;
      const box = item.querySelector("input.calendar-displayed");
      if (box && color && box.style.accentColor !== color) box.style.accentColor = color;
    }
  }

  // --- the views: day headings, event cards, the time zone ------------------------------------
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const zone = (() => {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: cal.dtz.defaultTimezone.tzid, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? ""; }
    catch { return ""; }
  })();
  const jsDate = (dt) => cal.dtz.dateTimeToJsDate(dt.getInTimezone(cal.dtz.defaultTimezone));
  const range = (item) => {
    const start = item.startDate ?? item.entryDate;
    const end = item.endDate ?? item.dueDate;
    if (!start) return "";
    if (start.isDate) return "All day";
    return end ? `${timeFormat.format(jsDate(start))} – ${timeFormat.format(jsDate(end))}` : timeFormat.format(jsDate(start));
  };

  function decorate() {
    for (const heading of document.querySelectorAll("#view-box .day-column-heading")) {
      const short = heading.querySelector("span:nth-child(2)")?.textContent ?? heading.textContent;
      if (heading.dataset.mwText === short) continue;
      heading.dataset.mwText = short;
      heading.querySelector(".mw-day")?.remove();
      const parts = short.trim().split(/\s+/);
      const number = parts.find((p) => /^\d+$/.test(p)) ?? "";
      const weekday = parts[0] ?? "";
      heading.append(el("span", { class: "mw-day" }, el("span", { class: "mw-dow", text: weekday }), el("span", { class: "mw-dnum", text: number })));
    }
    for (const corner of document.querySelectorAll("#view-box .multiday-header-corner")) {
      if (!corner.querySelector(".mw-zone")) corner.append(el("span", { class: "mw-zone", text: zone }));
    }
    for (const box of document.querySelectorAll("#view-box calendar-event-box:not([hidden])")) {
      const item = box.occurrence;
      const container = box.querySelector(".calendar-item-container");
      if (!item || !container) continue;
      const text = range(item);
      let time = container.querySelector(".mw-ev-time");
      if (!time) {
        time = el("div", { class: "mw-ev-time" });
        const location = container.querySelector(".location-desc");
        if (location) location.before(time); else container.append(time);
      }
      if (time.textContent !== text) time.textContent = text;
      const people = (item.getAttendees?.() ?? []).length > 0;
      const flex = container.querySelector(".calendar-item-flex");
      const icon = flex?.querySelector(".mw-ev-people");
      if (people && !icon) flex?.append(el("span", { class: "mw-ev-people", title: "Attendees" }));
      if (!people && icon) icon.remove();
    }
    colorCheckboxes();
    shortRange();
    minimonthTitle();
  }
  let queued = 0;
  const schedule = () => { if (!queued) queued = window.requestAnimationFrame(() => { queued = 0; try { decorate(); } catch (error) { console.error("Thoth: calendar", error); } }); };
  const observer = new window.MutationObserver(schedule);
  for (const id of ["view-box", "calendar-list", "calMinimonth", "calendarViewHeader"]) { const node = $(id); if (node) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style"] }); }
  schedule();
  undo.push(() => observer.disconnect());

  // --- the side panel (right): Today and the coming days, or the selected event ---------------
  // Thunderbird's Today pane lives here now. Docked beside the views when they keep room enough
  // (mw-narrow unset), else a sheet over them; hidden with the calendar (tasks mode).
  const SIDE_PREF = "extensions.mailworkspace.calendar.side";
  const SIDE_MIN = 1000; // below this width of the views' row, the panel is a sheet
  const side = add(el("aside", { id: "mw-cal-side", tabindex: "-1" }));
  $("calendar-view-box")?.after(side);
  const sideToggle = add(el("button", { id: "mw-cal-side-toggle", class: "button button-flat icon-button icon-only", type: "button", title: "Today and upcoming" }));
  $("calendarControlBarMenu")?.before(sideToggle);
  let sideOpen = Services.prefs.getBoolPref(SIDE_PREF, true); // the docked Today panel, by choice
  let sheetToday = false; // the Today sheet, opened by hand while narrow
  let narrow = false;
  let shown = null; // the event in the details
  function updateSide() {
    const mode = shown ? "details" : (narrow ? sheetToday : sideOpen) ? "today" : null;
    if (mode) panel.setAttribute("mw-side", mode); else panel.removeAttribute("mw-side");
    panel.toggleAttribute("mw-side-back", narrow ? sheetToday : sideOpen);
    sideToggle.setAttribute("aria-pressed", String(mode === "today"));
    if (mode === "today") void renderToday().catch((error) => console.error("Thoth: today", error));
  }
  sideToggle.addEventListener("click", () => {
    if (narrow) { const open = panel.getAttribute("mw-side") === "today"; shown = null; sheetToday = !open; }
    else if (shown) { shown = null; sideOpen = true; }
    else { sideOpen = !sideOpen; Services.prefs.setBoolPref(SIDE_PREF, sideOpen); }
    updateSide();
  });
  const displayRow = $("calendarDisplayBox");
  const header = $("calendarViewHeader");
  const resize = new window.ResizeObserver(() => {
    const top = `${Math.round(header?.getBoundingClientRect().height ?? 56)}px`;
    if (top !== "0px" && panel.style.getPropertyValue("--mw-cal-head") !== top) panel.style.setProperty("--mw-cal-head", top);
    const next = (displayRow?.getBoundingClientRect().width ?? 0) < SIDE_MIN;
    if (next !== narrow) { narrow = next; panel.toggleAttribute("mw-narrow", narrow); if (!narrow) sheetToday = false; updateSide(); }
  });
  if (displayRow) resize.observe(displayRow);
  if (header) resize.observe(header);
  undo.push(() => resize.disconnect());

  const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const duration = (a, b) => {
    const minutes = Math.round((b - a) / 60000);
    if (minutes <= 0) return "";
    if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
  };
  const alarmText = (alarm) => {
    const offset = alarm.offset;
    if (!offset) return "At a set time";
    const minutes = Math.abs(offset.inSeconds) / 60;
    const unit = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
    return minutes === 0 ? "At the start" : `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"} ${offset.inSeconds < 0 ? "before" : "after"}`;
  };
  const initials = (name) => name.replace(/<[^>]*>|mailto:/gi, "").split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const sideTop = (title) => {
    const back = el("button", { class: "mw-d-back", type: "button", title: "Back to today" }, el("span", { class: "mw-d-back-icon" }), el("span", { text: "Today" }));
    back.addEventListener("click", () => closeDetails());
    const close = el("button", { class: "mw-d-close", type: "button", title: "Close" });
    close.addEventListener("click", () => { if (shown) closeDetails(); else { if (narrow) sheetToday = false; else { sideOpen = false; Services.prefs.setBoolPref(SIDE_PREF, false); } updateSide(); } });
    return el("div", { class: "mw-d-top" }, shown ? back : null, title ? el("span", { class: "mw-cal-section-head mw-d-top-title", text: title }) : null, el("span", { class: "mw-d-spacer" }), close);
  };
  function closeDetails() {
    shown = null;
    window.currentView?.()?.setSelectedItems?.([]);
    for (const other of panel.querySelectorAll(".mw-ag-item.selected, .mw-sd-item.selected")) other.classList.remove("selected");
    updateSide();
  }
  function showDetails(item) {
    shown = item;
    if (!item) { updateSide(); return; }
    const start = item.startDate ?? item.entryDate;
    const end = item.endDate ?? item.dueDate;
    const rows = [];
    const row = (kind, ...content) => rows.push(el("div", { class: `mw-d-row mw-d-${kind}` }, el("span", { class: "mw-d-icon" }), el("div", { class: "mw-d-text" }, ...content)));
    if (start) {
      const a = jsDate(start);
      const b = end ? jsDate(end) : a;
      const sameDay = !end || a.toDateString() === new Date(b - (start.isDate ? 1 : 0)).toDateString();
      row("when", el("div", { text: dateFormat.format(a) + (sameDay ? "" : ` – ${dateFormat.format(new Date(b - (start.isDate ? 86400000 : 0)))}`) }),
        el("div", { class: "mw-d-sub", text: start.isDate ? "All day" : `${range(item)}${duration(a, b) ? ` (${duration(a, b)})` : ""}` }));
    }
    const location = item.getProperty("LOCATION");
    if (location) row("where", el("div", { text: location }));
    const alarms = item.getAlarms?.() ?? [];
    if (alarms.length) row("alarm", ...alarms.map((alarm) => el("div", { text: alarmText(alarm) })));
    if (item.calendar) row("calendar", el("div", { class: "mw-d-cal", style: `--c: ${item.calendar.getProperty("color") || "#9aa3b2"}` }, el("span", { class: "mw-d-swatch" }), el("span", { text: item.calendar.name })));
    const categories = item.getCategories?.() ?? [];
    if (categories.length) row("tags", el("div", { class: "mw-d-chips" }, ...categories.map((name) => el("span", { class: "mw-d-chip", style: `--tag: ${tagColor(name)}`, text: name }))));
    const description = (item.getProperty("DESCRIPTION") ?? "").trim();
    const attendees = item.getAttendees?.() ?? [];
    const status = { ACCEPTED: "yes", DECLINED: "no", TENTATIVE: "maybe" };
    const people = attendees.map((a) => {
      const name = a.commonName || a.id.replace(/^mailto:/i, "");
      const me = item.calendar?.getProperty("organizerId") && a.id.toLowerCase() === String(item.calendar.getProperty("organizerId")).toLowerCase();
      return el("li", { class: "mw-d-person" }, el("span", { class: "mw-d-avatar", text: initials(name) || "?" }), el("span", { class: "mw-d-name", text: `${name}${me ? " (You)" : ""}` }), el("span", { class: `mw-d-rsvp mw-d-rsvp-${status[a.participationStatus] ?? "unknown"}`, title: a.participationStatus || "No answer yet" }));
    });
    const edit = el("button", { class: "mw-d-edit", type: "button", text: "Edit" });
    edit.addEventListener("click", () => window.modifyEventWithDialog(item, true));
    const remove = el("button", { class: "mw-d-delete", type: "button", text: "Delete" });
    remove.addEventListener("click", () => { window.currentView?.()?.setSelectedItems?.([item]); window.deleteSelectedEvents(); closeDetails(); });
    const readOnly = item.calendar?.readOnly;
    let more = null;
    if (description) {
      const text = el("div", { class: "mw-d-description mw-d-clamped", text: description });
      more = [text];
      if (description.length > 240 || description.split("\n").length > 5) {
        const toggle = el("button", { class: "mw-d-more", type: "button", text: "More" });
        toggle.addEventListener("click", () => { const open = text.classList.toggle("mw-d-clamped"); toggle.textContent = open ? "More" : "Less"; });
        more.push(toggle);
      }
    }
    side.replaceChildren(...[
      sideTop(null),
      el("div", { class: "mw-side-body" }, ...[
        el("h2", { class: "mw-d-title", style: `--c: ${item.calendar?.getProperty("color") || "#5b8def"}` }, el("span", { class: `mw-d-kind${attendees.length ? " mw-d-meeting" : ""}` }), el("span", { text: item.title || "(No title)" })),
        ...rows,
        ...(more ?? []),
        attendees.length ? el("div", { class: "mw-d-attendees" }, el("div", { class: "mw-d-head", text: `Attendees (${attendees.length})` }), el("ol", {}, ...people)) : null,
      ].filter(Boolean)),
      readOnly ? null : el("div", { class: "mw-d-actions" }, edit, remove),
    ].filter(Boolean));
    updateSide();
  }
  const onSelect = (event) => {
    const items = event.detail ?? [];
    if (items.length === 1) showDetails(items[0]);
    else if (shown) { shown = null; updateSide(); }
  };
  $("view-box")?.addEventListener("itemselect", onSelect, true);
  undo.push(() => $("view-box")?.removeEventListener("itemselect", onSelect, true));
  const onKey = (event) => { if (event.key === "Escape" && panel.hasAttribute("mw-side") && (shown || narrow)) { event.preventDefault(); if (shown) closeDetails(); else { sheetToday = false; updateSide(); } } };
  panel.addEventListener("keydown", onKey);
  undo.push(() => panel.removeEventListener("keydown", onKey));

  // Today: today's events (those over greyed), the tasks due by today, then the next six days.
  const DAY = 86400000;
  const relDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
  const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  let todayToken = 0;
  async function renderToday() {
    const token = ++todayToken;
    const composite = cal.view.getCompositeCalendar(window);
    const now = new Date();
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 7 * DAY);
    const tz = cal.dtz.defaultTimezone;
    const events = await composite.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES, 0, cal.dtz.jsDateToDateTime(from, tz), cal.dtz.jsDateToDateTime(to, tz));
    const todos = await composite.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_TYPE_TODO | Ci.calICalendar.ITEM_FILTER_COMPLETED_NO | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES, 0, null, null);
    if (token !== todayToken) return;
    const span = (item) => {
      const a = jsDate(item.startDate);
      const b = item.endDate ? jsDate(item.endDate) : a;
      return [a, b > a ? b : new Date(a.getTime() + 1)];
    };
    const days = [];
    for (let i = 0; i < 7; i++) {
      const start = new Date(from);
      start.setDate(from.getDate() + i);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      const list = events.filter((item) => { const [a, b] = span(item); return a < end && b > start; });
      list.sort((x, y) => (y.startDate.isDate - x.startDate.isDate) || (jsDate(x.startDate) - jsDate(y.startDate)));
      days.push({ start, end, list });
    }
    const endOfToday = days[0].end;
    const due = todos.filter((todo) => todo.dueDate && jsDate(todo.dueDate) < endOfToday).sort((x, y) => jsDate(x.dueDate) - jsDate(y.dueDate));
    const itemRow = (item, day) => {
      const [, b] = span(item);
      const past = !item.startDate.isDate && b <= now;
      const multi = item.startDate.isDate ? (span(item)[1] - span(item)[0]) > DAY : jsDate(item.startDate) < day.start || b > day.end;
      const time = item.startDate.isDate ? "All day" : multi ? (jsDate(item.startDate) < day.start ? (b > day.end ? "All day" : `until ${timeFormat.format(b)}`) : `from ${timeFormat.format(jsDate(item.startDate))}`) : timeFormat.format(jsDate(item.startDate));
      const li = el("li", { class: `mw-sd-item${past ? " mw-sd-past" : ""}`, style: `--c: ${item.calendar?.getProperty("color") || "#5b8def"}`, tabindex: "0", title: `${item.title || "(No title)"}\n${range(item)}` },
        el("span", { class: "mw-sd-bar" }),
        el("span", { class: "mw-sd-main" }, el("span", { class: "mw-sd-title", text: item.title || "(No title)" }), item.getProperty("LOCATION") ? el("span", { class: "mw-sd-where", text: item.getProperty("LOCATION") }) : null),
        el("span", { class: "mw-sd-time", text: time }));
      const open = () => { for (const other of side.querySelectorAll(".mw-sd-item.selected")) other.classList.remove("selected"); li.classList.add("selected"); showDetails(item); };
      li.addEventListener("click", open);
      li.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
      li.addEventListener("dblclick", () => window.modifyEventWithDialog(item, true));
      return li;
    };
    const taskRow = (todo) => {
      const overdue = jsDate(todo.dueDate) < (todo.dueDate.isDate ? days[0].start : now);
      const check = el("button", { class: "mw-sd-check", type: "button", title: "Mark as done" });
      check.addEventListener("click", (event) => {
        event.stopPropagation();
        const copy = todo.clone();
        copy.isCompleted = true;
        void todo.calendar.modifyItem(copy, todo).catch((error) => console.error("Thoth: complete task", error));
      });
      const li = el("li", { class: `mw-sd-task${overdue ? " mw-sd-overdue" : ""}`, tabindex: "0" }, check,
        el("span", { class: "mw-sd-title", text: todo.title || "(No title)" }),
        el("span", { class: "mw-sd-time", text: overdue ? (todo.dueDate.isDate || jsDate(todo.dueDate) < days[0].start ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(jsDate(todo.dueDate)) : timeFormat.format(jsDate(todo.dueDate))) : (todo.dueDate.isDate ? "Today" : timeFormat.format(jsDate(todo.dueDate))) }));
      li.addEventListener("dblclick", () => window.modifyEventWithDialog(todo, true));
      li.addEventListener("keydown", (event) => { if (event.key === "Enter") window.modifyEventWithDialog(todo, true); });
      return li;
    };
    const sections = [];
    const todayList = days[0].list;
    sections.push(el("section", { class: "mw-sd-day mw-sd-today" },
      el("div", { class: "mw-sd-date" }, el("span", { class: "mw-sd-num", text: String(now.getDate()) }), el("span", { class: "mw-sd-datetext" }, el("span", { class: "mw-sd-dow", text: weekdayFormat.format(now) }), el("span", { class: "mw-sd-month", text: relDay.format(now).replace(weekdayFormat.format(now), "").replace(/^[,\s]+/, "") }))),
      todayList.length ? el("ol", { class: "mw-sd-list" }, ...todayList.map((item) => itemRow(item, days[0]))) : el("p", { class: "mw-sd-empty", text: "Nothing planned today." })));
    if (due.length) sections.push(el("section", { class: "mw-sd-day" }, el("h3", { class: "mw-cal-section-head", text: `Tasks due (${due.length})` }), el("ol", { class: "mw-sd-list" }, ...due.slice(0, 12).map(taskRow))));
    const later = days.slice(1).filter((day) => day.list.length);
    for (const day of later) {
      const label = day === days[1] ? "Tomorrow" : relDay.format(day.start);
      sections.push(el("section", { class: "mw-sd-day" }, el("h3", { class: "mw-cal-section-head", text: label }), el("ol", { class: "mw-sd-list" }, ...day.list.map((item) => itemRow(item, day)))));
    }
    if (!later.length) sections.push(el("p", { class: "mw-sd-empty mw-sd-quiet", text: "Nothing else this week." }));
    if (shown) return; // an event was opened meanwhile
    side.replaceChildren(sideTop("Today"), el("div", { class: "mw-side-body" }, ...sections));
  }
  // Keep Today current: past events grey out, and the day turns over at midnight.
  const tick = window.setInterval(() => { if (panel.getAttribute("mw-side") === "today") void renderToday().catch(() => {}); }, 60000);
  undo.push(() => window.clearInterval(tick));

  // --- Agenda --------------------------------------------------------------------------------
  const agenda = add(el("div", { id: "mw-agenda", hidden: "true" }));
  $("view-box")?.after(agenda);
  let agendaOn = false;
  const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
  async function renderAgenda() {
    const composite = cal.view.getCompositeCalendar(window);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 60 * 86400000);
    const filter = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
    const items = await composite.getItemsAsArray(filter, 0, cal.dtz.jsDateToDateTime(from, cal.dtz.defaultTimezone), cal.dtz.jsDateToDateTime(to, cal.dtz.defaultTimezone));
    items.sort((a, b) => a.startDate.compare(b.startDate));
    const days = new Map();
    for (const item of items) {
      const key = jsDate(item.startDate).toDateString();
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(item);
    }
    const groups = [...days].map(([key, list]) => {
      const date = new Date(key);
      const isToday = key === new Date().toDateString();
      return el("section", { class: `mw-ag-day${isToday ? " mw-ag-today" : ""}` },
        el("h3", {}, el("span", { class: "mw-ag-num", text: String(date.getDate()) }), el("span", { text: dayFormat.format(date) })),
        el("ol", {}, ...list.map((item) => {
          const li = el("li", { class: "mw-ag-item", style: `--c: ${item.calendar?.getProperty("color") || "#5b8def"}`, tabindex: "0" },
            el("span", { class: "mw-ag-time", text: range(item) }), el("span", { class: "mw-ag-bar" }), el("span", { class: "mw-ag-title", text: item.title || "(No title)" }),
            item.getProperty("LOCATION") ? el("span", { class: "mw-ag-where", text: item.getProperty("LOCATION") }) : null);
          li.addEventListener("click", () => { for (const other of agenda.querySelectorAll(".mw-ag-item.selected")) other.classList.remove("selected"); li.classList.add("selected"); showDetails(item); });
          li.addEventListener("dblclick", () => window.modifyEventWithDialog(item, true));
          return li;
        })));
    });
    agenda.replaceChildren(...(groups.length ? groups : [el("p", { class: "mw-ag-empty", text: "Nothing in the next 60 days." })]));
  }
  function setAgenda(on) {
    agendaOn = on;
    panel.toggleAttribute("mw-agenda", on);
    agenda.hidden = !on;
    agendaButton.setAttribute("aria-selected", String(on));
    for (const button of toggle?.querySelectorAll(".calview-toggle-item:not(#mw-calTabAgenda)") ?? []) {
      if (on) { button.dataset.mwSelected = button.getAttribute("aria-selected"); button.setAttribute("aria-selected", "false"); }
      else if (button.dataset.mwSelected) { button.setAttribute("aria-selected", button.dataset.mwSelected); delete button.dataset.mwSelected; }
    }
    if (interval) interval.toggleAttribute("mw-hidden", on);
    if (on) void renderAgenda().catch((error) => console.error("Thoth: agenda", error));
  }
  agendaButton.addEventListener("click", () => setAgenda(true));
  const offAgenda = (event) => { if (agendaOn && event.target.closest?.(".calview-toggle-item:not(#mw-calTabAgenda), #previousViewButton, #nextViewButton, #todayViewButton, #mw-cal-today")) setAgenda(false); };
  $("calendarViewHeader")?.addEventListener("click", offAgenda, true);
  undo.push(() => $("calendarViewHeader")?.removeEventListener("click", offAgenda, true));
  // The agenda follows changes to the calendars.
  const calObserver = {
    QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
    onStartBatch() {}, onEndBatch() {}, onLoad() { changed(); }, onError() {}, onPropertyChanged() {}, onPropertyDeleting() {},
    onAddItem() { changed(); }, onModifyItem(item) { changed(); if (shown && item.hashId === shown.hashId) showDetails(item); },
    onDeleteItem(item) { changed(); if (shown && item.hashId === shown.hashId) closeDetails(); },
  };
  let changeTimer = 0;
  function changed() {
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      if (agendaOn) void renderAgenda().catch(() => {});
      if (panel.getAttribute("mw-side") === "today") void renderToday().catch(() => {});
      void countTags().catch(() => {});
    }, 150);
  }
  try { cal.view.getCompositeCalendar(window).addObserver(calObserver); undo.push(() => cal.view.getCompositeCalendar(window).removeObserver(calObserver)); } catch (error) { console.error(error); }

  // A small menu under a button.
  function openMenu(anchor, items) {
    document.getElementById("mw-cal-menu")?.remove();
    const menu = el("div", { id: "mw-cal-menu" }, ...items.map(([label, run]) => {
      const button = el("button", { type: "button", text: label });
      button.addEventListener("click", () => { menu.remove(); run(); });
      return button;
    }));
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    document.documentElement.append(menu);
    const away = (event) => { if (!menu.contains(event.target)) { menu.remove(); window.removeEventListener("mousedown", away, true); } };
    window.addEventListener("mousedown", away, true);
  }

  panel.setAttribute("mw-calendar", "true");
  updateSide();
  return () => {
    for (const fn of undo) { try { fn(); } catch { /* gone */ } }
    for (const node of added) node.remove();
    document.getElementById("mw-cal-menu")?.remove();
    for (const name of ["mw-calendar", "mw-agenda", "mw-search", "mw-side", "mw-narrow", "mw-side-back"]) panel.removeAttribute(name);
    interval?.removeAttribute("mw-hidden");
    panel.style.removeProperty("--mw-cal-head");
    if (listLabel && oldListLabel) listLabel.textContent = oldListLabel;
    for (const heading of document.querySelectorAll("#view-box .day-column-heading")) { heading.querySelector(".mw-day")?.remove(); delete heading.dataset.mwText; }
    for (const time of document.querySelectorAll("#view-box .mw-ev-time, #view-box .mw-ev-people, #view-box .mw-zone")) time.remove();
    try { window.windowUtils.removeSheetUsingURIString(CAL_SHEET, window.windowUtils.AUTHOR_SHEET); } catch { /* not loaded */ }
  };
}
