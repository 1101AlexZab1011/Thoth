/* Tasks, redesigned in the workspace style on top of Thunderbird's own tasks (so storage, sync and
   the edit dialog stay Thunderbird's). The task view's tree is replaced by:
   - a header: "Tasks", a Plans / All tasks switch, search (Ctrl+K);
   - All tasks: a toolbar (New task ▾, All / Open / Completed, sort) and the tasks grouped by when
     they are due (Overdue, Today, Tomorrow, This week, Next week, Later, No date, Completed), each
     row with a checkbox, title, priority, due date, tags and its plan;
   - Plans: tasks with subtasks, grouped by their first tag, each with its timeline and progress
     (the share of subtasks done); a plan is a task marked X-MW-PLAN or one that has subtasks, and
     a subtask points to its plan with iCalendar's RELATED-TO (PARENT);
   - a details panel for the selected task or plan: progress, timeline, goal, tags, the subtasks as
     a checklist with a field to add one, attachments, Edit and Delete;
   - on the left, Filter Tasks with counts instead of Thunderbird's radio list.
   Loaded into the experiment's scope (implementation.js); installTasks() returns its undo. */
/* global Services, Ci, Cc, ChromeUtils */

const TASKS_SHEET = "resource://mailworkspace/theme/tasks.css";
const PLAN_PROP = "X-MW-PLAN";
const STAR_PROP = "X-MW-STARRED";

function installTasks(window) {
  const document = window.document;
  const box = document.getElementById("calendar-task-box");
  const panel = document.getElementById("calendarTabPanel");
  const cal = window.cal;
  if (!box || !panel || !cal) return () => {};
  window.windowUtils.loadSheetUsingURIString(TASKS_SHEET, window.windowUtils.AUTHOR_SHEET);
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/1999/xhtml";
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  };
  const added = [];
  const undo = [];

  // --- state ---------------------------------------------------------------------------------
  const state = { view: "tasks", filter: "all", status: "all", sort: "due", query: "", selected: null, collapsed: new Set(["Completed"]), items: [] };
  const prefs = (() => { try { return JSON.parse(Services.prefs.getStringPref("extensions.mailworkspace.tasks.view", "{}")); } catch { return {}; } })();
  if (prefs.view === "plans" || prefs.view === "tasks") state.view = prefs.view;
  if (["due", "priority", "title"].includes(prefs.sort)) state.sort = prefs.sort;
  const remember = () => Services.prefs.setStringPref("extensions.mailworkspace.tasks.view", JSON.stringify({ view: state.view, sort: state.sort }));

  const tz = () => cal.dtz.defaultTimezone;
  const jsDate = (dt) => (dt ? cal.dtz.dateTimeToJsDate(dt.isDate ? dt : dt.getInTimezone(tz())) : null);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const dayYearFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const tagColor = (name) => Services.prefs.getStringPref(`calendar.category.color.${cal.view.formatStringForCSSRule(name)}`, "") || "#8a91a1";
  const isPlan = (item) => item.getProperty(PLAN_PROP) === "TRUE" || childrenOf(item).length > 0;
  const parentId = (item) => item.getRelations().find((r) => (r.relType || "PARENT").toUpperCase() === "PARENT")?.relId ?? null;
  const childrenOf = (item) => state.items.filter((t) => parentId(t) === item.id);
  const progress = (item) => {
    const kids = childrenOf(item);
    if (!kids.length) return item.isCompleted ? 100 : item.percentComplete || 0;
    return Math.round((kids.filter((k) => k.isCompleted).length / kids.length) * 100);
  };
  const priority = (item) => (!item.priority ? null : item.priority <= 4 ? "high" : item.priority === 5 ? "medium" : "low");
  const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" };
  const firstWeekday = Services.prefs.getIntPref("calendar.week.start", 0);

  /** When a task is due, relative to today: [group, label]. */
  function dueGroup(item) {
    if (item.isCompleted) return "Completed";
    const due = jsDate(item.dueDate);
    if (!due) return "No date";
    const today = startOfDay(new Date());
    const day = startOfDay(due);
    if (day < today) return "Overdue";
    if (+day === +today) return "Today";
    if (+day === +addDays(today, 1)) return "Tomorrow";
    const weekStart = addDays(today, -((today.getDay() - firstWeekday + 7) % 7));
    if (day < addDays(weekStart, 7)) return "This week";
    if (day < addDays(weekStart, 14)) return "Next week";
    return "Later";
  }
  const GROUPS = ["Overdue", "Today", "Tomorrow", "This week", "Next week", "Later", "No date", "Completed"];
  function groupNote(name) {
    const today = startOfDay(new Date());
    const weekStart = addDays(today, -((today.getDay() - firstWeekday + 7) % 7));
    if (name === "Today") return weekdayFmt.format(today);
    if (name === "Tomorrow") return weekdayFmt.format(addDays(today, 1));
    if (name === "This week") return `${dayFmt.format(weekStart)} – ${dayFmt.format(addDays(weekStart, 6))}`;
    if (name === "Next week") return `${dayFmt.format(addDays(weekStart, 7))} – ${dayFmt.format(addDays(weekStart, 13))}`;
    return "";
  }
  function dueText(item) {
    const due = jsDate(item.dueDate);
    if (!due) return "";
    const today = startOfDay(new Date());
    const day = startOfDay(due);
    const time = item.dueDate.isDate ? "" : `, ${timeFmt.format(due)}`;
    if (+day === +today) return `Today${time}`;
    if (+day === +addDays(today, 1)) return `Tomorrow${time}`;
    return `${day.getFullYear() === today.getFullYear() ? dayFmt.format(due) : dayYearFmt.format(due)}${time}`;
  }
  function timeline(item) {
    const start = jsDate(item.entryDate);
    const due = jsDate(item.dueDate);
    if (start && due) return `${dayFmt.format(start)} – ${dayYearFmt.format(due)}`;
    if (due) return `By ${dayYearFmt.format(due)}`;
    if (start) return `From ${dayYearFmt.format(start)}`;
    return "";
  }

  /** Which filter (left column) a task passes. */
  function passes(item, filter) {
    const today = startOfDay(new Date());
    const due = jsDate(item.dueDate);
    if (filter === "all") return true;
    if (filter === "completed") return item.isCompleted;
    if (item.isCompleted) return false;
    if (filter === "today") return due && startOfDay(due) <= today;
    if (filter === "next7") return due && startOfDay(due) < addDays(today, 7);
    if (filter === "notstarted") return !item.percentComplete && item.status !== "IN-PROCESS";
    if (filter === "overdue") return due && due < new Date();
    return true;
  }
  const FILTERS = [["all", "All tasks", "checklist"], ["today", "Today", "today"], ["next7", "Next 7 days", "date_range"], ["notstarted", "Not started", "play_arrow"], ["overdue", "Overdue", "warning"], ["completed", "Completed", "task_alt"]];

  // --- the page ------------------------------------------------------------------------------
  const root = el("div", { id: "mw-tasks" });
  box.append(root);
  added.push(root);
  const filters = el("div", { id: "mw-task-filters" });
  $("task-filter-pane")?.append(filters);
  added.push(filters);

  const search = el("input", { class: "mw-t-search-input", type: "text", placeholder: "Search tasks…", oninput: () => { state.query = search.value.trim().toLowerCase(); render(); } });
  const onKey = (event) => {
    if (box.hasAttribute("collapsed") || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
    event.preventDefault();
    search.focus();
    search.select();
  };
  window.addEventListener("keydown", onKey, true);
  undo.push(() => window.removeEventListener("keydown", onKey, true));

  const taskCalendar = () => {
    const visible = cal.manager.getCalendars().filter((c) => !c.readOnly && !c.getProperty("disabled") && c.getProperty("capabilities.tasks.supported") !== false && c.getProperty("calendar-main-in-composite") !== false);
    const selected = window.getSelectedCalendar?.();
    return visible.includes(selected) ? selected : visible[0];
  };
  const newTodo = (title, extra = {}) => {
    const todo = Cc["@mozilla.org/calendar/todo;1"].createInstance(Ci.calITodo);
    todo.title = title;
    todo.calendar = extra.calendar ?? taskCalendar();
    if (extra.plan) todo.setProperty(PLAN_PROP, "TRUE");
    if (extra.parent) {
      const relation = Cc["@mozilla.org/calendar/relation;1"].createInstance(Ci.calIRelation);
      relation.relType = "PARENT";
      relation.relId = extra.parent.id;
      todo.addRelation(relation);
      for (const name of extra.parent.getCategories()) todo.setCategories([...todo.getCategories(), name]);
    }
    return todo;
  };
  const ask = (title, label) => { const result = { value: "" }; return Services.prompt.prompt(window, title, label, result, null, {}) && result.value.trim() ? result.value.trim() : null; };
  async function save(next, old) {
    try { await (old ? next.calendar.modifyItem(next, old) : next.calendar.addItem(next)); }
    catch (error) { Services.prompt.alert(window, "Tasks", `Could not save: ${error.message ?? error}`); }
  }
  async function toggleDone(item) {
    const next = item.clone();
    next.isCompleted = !item.isCompleted;
    if (!next.isCompleted) next.percentComplete = 0;
    await save(next, item);
  }
  async function toggleStar(item) {
    const next = item.clone();
    if (item.getProperty(STAR_PROP) === "TRUE") next.deleteProperty(STAR_PROP); else next.setProperty(STAR_PROP, "TRUE");
    await save(next, item);
  }
  async function remove(item) {
    const kids = childrenOf(item);
    const what = kids.length ? `“${item.title}” and its ${kids.length} subtask${kids.length === 1 ? "" : "s"}` : `“${item.title}”`;
    if (!Services.prompt.confirm(window, "Delete", `Delete ${what}?`)) return;
    for (const kid of kids) await kid.calendar.deleteItem(kid).catch(() => {});
    await item.calendar.deleteItem(item).catch((error) => Services.prompt.alert(window, "Tasks", String(error?.message ?? error)));
    if (state.selected === item.id) state.selected = null;
  }
  const edit = (item) => window.modifyEventWithDialog(item, true);
  async function newTask() {
    const title = ask("New task", "What needs doing?");
    if (title) await save(newTodo(title));
  }
  async function newPlan() {
    const title = ask("New plan", "Name of the plan:");
    if (!title) return;
    const plan = newTodo(title, { plan: true });
    await save(plan);
    state.selected = plan.id;
    state.view = "plans";
    render();
  }

  function menu(anchor, items) {
    document.getElementById("mw-cal-menu")?.remove();
    const list = el("div", { id: "mw-cal-menu" }, items.map(([label, run, danger]) => el("button", { type: "button", class: danger ? "danger" : null, text: label, onclick: () => { list.remove(); run(); } })));
    const rect = anchor.getBoundingClientRect();
    list.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
    list.style.top = `${rect.bottom + 4}px`;
    document.documentElement.append(list);
    const away = (event) => { if (!list.contains(event.target)) { list.remove(); window.removeEventListener("mousedown", away, true); } };
    window.addEventListener("mousedown", away, true);
  }

  // --- rendering -----------------------------------------------------------------------------
  const visible = (item) => (!state.query || `${item.title} ${item.getProperty("DESCRIPTION") ?? ""} ${item.getCategories().join(" ")}`.toLowerCase().includes(state.query));
  const sorter = (a, b) => {
    if (state.sort === "title") return (a.title || "").localeCompare(b.title || "");
    if (state.sort === "priority") return (a.priority || 10) - (b.priority || 10) || (jsDate(a.dueDate) ?? Infinity) - (jsDate(b.dueDate) ?? Infinity);
    return (jsDate(a.dueDate) ?? Infinity) - (jsDate(b.dueDate) ?? Infinity) || (a.priority || 10) - (b.priority || 10);
  };

  function chip(kind, icon, text, style) { return el("span", { class: `mw-t-chip mw-t-chip-${kind}`, style }, icon ? el("span", { class: `mw-t-ico mw-i-${icon}` }) : null, text); }

  function row(item) {
    const plan = state.items.find((t) => t.id === parentId(item));
    const p = priority(item);
    const overdue = !item.isCompleted && jsDate(item.dueDate) && jsDate(item.dueDate) < new Date();
    const more = el("button", { class: "mw-t-more", type: "button", title: "More", onclick: (event) => {
      event.stopPropagation();
      menu(more, [["Edit…", () => edit(item)], [item.isCompleted ? "Mark as not done" : "Mark as done", () => toggleDone(item)], ["Delete", () => remove(item), true]]);
    } });
    return el("li", { class: `mw-t-row${item.isCompleted ? " done" : ""}${overdue ? " overdue" : ""}${state.selected === item.id ? " selected" : ""}`, tabindex: "0",
      onclick: () => { state.selected = item.id; render(); }, ondblclick: () => edit(item) },
      el("input", { type: "checkbox", class: "mw-t-check", checked: item.isCompleted, title: item.isCompleted ? "Mark as not done" : "Mark as done", onclick: (event) => { event.stopPropagation(); void toggleDone(item); } }),
      el("span", { class: "mw-t-title", text: item.title || "(No title)" }),
      el("span", { class: "mw-t-chips" },
        p ? chip(`prio-${p}`, "flag", PRIORITY_LABEL[p]) : null,
        dueText(item) ? chip(overdue ? "due overdue" : "due", "event", dueText(item)) : null,
        ...item.getCategories().slice(0, 2).map((name) => chip("tag", null, name, `--tag: ${tagColor(name)}`)),
        plan ? chip("plan", "account_tree", plan.title) : null),
      more);
  }

  function renderTasks(list) {
    const items = state.items.filter((t) => passes(t, state.filter) && visible(t) && (state.status === "all" || (state.status === "open" ? !t.isCompleted : t.isCompleted)));
    const groups = GROUPS.map((name) => [name, items.filter((t) => dueGroup(t) === name).sort(sorter)]).filter(([, l]) => l.length);
    if (!groups.length) { list.append(el("div", { class: "mw-t-empty" }, el("p", { text: state.query ? "No task matches." : "No tasks here." }), el("button", { class: "mw-t-btn", type: "button", text: "New task", onclick: () => void newTask() }))); return; }
    for (const [name, tasks] of groups) {
      const closed = state.collapsed.has(name);
      list.append(el("section", { class: `mw-t-group mw-t-group-${name.toLowerCase().replace(/\s+/g, "-")}${closed ? " closed" : ""}` },
        el("button", { class: "mw-t-group-head", type: "button", onclick: () => { if (closed) state.collapsed.delete(name); else state.collapsed.add(name); render(); } },
          el("span", { class: "mw-t-caret" }), el("span", { class: "mw-t-group-name", text: name }),
          groupNote(name) ? el("span", { class: "mw-t-group-note", text: `· ${groupNote(name)}` }) : null, el("span", { class: "mw-t-count", text: String(tasks.length) })),
        closed ? null : el("ol", { class: "mw-t-rows" }, tasks.map(row))));
    }
  }

  function planCard(plan) {
    const pct = progress(plan);
    const kids = childrenOf(plan);
    const starred = plan.getProperty(STAR_PROP) === "TRUE";
    return el("li", { class: `mw-p-card${state.selected === plan.id ? " selected" : ""}${pct === 100 ? " complete" : ""}`, tabindex: "0", onclick: () => { state.selected = plan.id; render(); }, ondblclick: () => edit(plan) },
      el("span", { class: `mw-p-icon${pct === 100 ? " done" : ""}` }),
      el("div", { class: "mw-p-main" },
        el("div", { class: "mw-p-title", text: plan.title || "(No title)" }),
        el("div", { class: "mw-p-sub" }, timeline(plan) ? chip("due", "event", timeline(plan)) : null, el("span", { class: "mw-p-count", text: kids.length ? `${kids.filter((k) => k.isCompleted).length}/${kids.length} done` : "No subtasks yet" })),
        el("div", { class: "mw-p-progress" }, el("span", { class: "mw-p-bar" }, el("span", { style: `width: ${pct}%` })), el("span", { class: "mw-p-pct", text: `${pct}%` }))),
      el("button", { class: `mw-p-star${starred ? " on" : ""}`, type: "button", title: starred ? "Unstar" : "Star", onclick: (event) => { event.stopPropagation(); void toggleStar(plan); } }));
  }

  function renderPlans(list) {
    const plans = state.items.filter((t) => isPlan(t) && !parentId(t) && visible(t));
    if (!plans.length) {
      list.append(el("div", { class: "mw-t-empty" }, el("p", { text: "No plans yet. A plan is a task with subtasks: a project, a paper, a course." }), el("button", { class: "mw-t-btn primary", type: "button", text: "New plan", onclick: () => void newPlan() })));
      return;
    }
    const byTag = new Map();
    for (const plan of plans) {
      const tag = plan.getCategories()[0] ?? "No tag";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(plan);
    }
    for (const [tag, group] of [...byTag].sort((a, b) => (a[0] === "No tag") - (b[0] === "No tag") || a[0].localeCompare(b[0]))) {
      group.sort((a, b) => (b.getProperty(STAR_PROP) === "TRUE") - (a.getProperty(STAR_PROP) === "TRUE") || sorter(a, b));
      const pct = Math.round(group.reduce((sum, p) => sum + progress(p), 0) / group.length);
      const closed = state.collapsed.has(`plan:${tag}`);
      list.append(el("section", { class: `mw-p-group${closed ? " closed" : ""}`, style: `--tag: ${tag === "No tag" ? "var(--mw-text-3)" : tagColor(tag)}` },
        el("button", { class: "mw-p-group-head", type: "button", onclick: () => { if (closed) state.collapsed.delete(`plan:${tag}`); else state.collapsed.add(`plan:${tag}`); render(); } },
          el("span", { class: "mw-t-caret" }), el("span", { class: "mw-p-folder" }), el("span", { class: "mw-t-group-name", text: tag }),
          el("span", { class: "mw-t-group-note", text: `${group.length} plan${group.length === 1 ? "" : "s"}` }),
          el("span", { class: "mw-p-progress small" }, el("span", { class: "mw-p-bar" }, el("span", { style: `width: ${pct}%` })), el("span", { class: "mw-p-pct", text: `${pct}%` }))),
        closed ? null : el("ol", { class: "mw-p-cards" }, group.map(planCard))));
    }
  }

  function renderDetails(aside) {
    const item = state.items.find((t) => t.id === state.selected);
    aside.hidden = !item;
    if (!item) return;
    const kids = childrenOf(item).sort(sorter);
    const pct = progress(item);
    const plan = isPlan(item);
    const parent = state.items.find((t) => t.id === parentId(item));
    const starred = item.getProperty(STAR_PROP) === "TRUE";
    const facts = [];
    const fact = (icon, label, ...value) => facts.push(el("div", { class: "mw-d-fact" }, el("span", { class: `mw-t-ico mw-i-${icon}` }), el("span", { class: "mw-d-label", text: label }), el("div", { class: "mw-d-value" }, ...value)));
    if (timeline(item)) fact("event", plan ? "Timeline" : "Due", timeline(item));
    if (priority(item)) fact("flag", "Priority", chip(`prio-${priority(item)}`, null, PRIORITY_LABEL[priority(item)]));
    if (item.getCategories().length) fact("sell", "Tags", el("span", { class: "mw-t-chips" }, item.getCategories().map((name) => chip("tag", null, name, `--tag: ${tagColor(name)}`))));
    if (parent) fact("account_tree", "Plan", el("button", { class: "mw-d-link", type: "button", text: parent.title, onclick: () => { state.selected = parent.id; render(); } }));
    if (item.calendar) fact("calendar_month", "Calendar", item.calendar.name);
    const goal = (item.getProperty("DESCRIPTION") ?? "").trim();
    const addField = el("input", { class: "mw-d-add-input", type: "text", placeholder: "Add a subtask, then Enter",
      onkeydown: async (event) => {
        if (event.key !== "Enter" || !addField.value.trim()) return;
        const title = addField.value.trim();
        addField.value = "";
        await save(newTodo(title, { parent: item, calendar: item.calendar }));
      } });
    const attachments = item.getAttachments?.() ?? [];
    aside.replaceChildren(...[
      el("div", { class: "mw-td-head" },
        el("span", { class: `mw-d-badge${plan ? " plan" : ""}` }),
        el("h2", { class: "mw-d-title", text: item.title || "(No title)" }),
        el("button", { class: `mw-p-star${starred ? " on" : ""}`, type: "button", title: starred ? "Unstar" : "Star", onclick: () => void toggleStar(item) }),
        el("button", { class: "mw-d-close", type: "button", title: "Close", onclick: () => { state.selected = null; render(); } })),
      goal ? el("p", { class: "mw-d-goal", text: goal }) : null,
      el("div", { class: "mw-p-progress big" }, el("span", { class: "mw-p-bar" }, el("span", { style: `width: ${pct}%` })), el("span", { class: "mw-p-pct", text: `${pct}%` })),
      el("div", { class: "mw-d-facts" }, facts),
      el("section", { class: "mw-d-subtasks" },
        el("div", { class: "mw-d-section-head" }, el("span", { text: "Subtasks" }), el("span", { class: "mw-t-count", text: String(kids.length) })),
        el("ol", {}, kids.map((kid) => el("li", { class: `mw-d-sub${kid.isCompleted ? " done" : ""}` },
          el("input", { type: "checkbox", class: "mw-t-check", checked: kid.isCompleted, onclick: () => void toggleDone(kid) }),
          el("button", { class: "mw-d-sub-title", type: "button", text: kid.title, onclick: () => { state.selected = kid.id; render(); }, ondblclick: () => edit(kid) }),
          dueText(kid) ? chip("due", "event", dueText(kid)) : null))),
        item.calendar?.readOnly ? null : addField),
      attachments.length ? el("section", { class: "mw-d-attach" }, el("div", { class: "mw-d-section-head" }, el("span", { text: "Attachments" }), el("span", { class: "mw-t-count", text: String(attachments.length) })),
        el("ol", {}, attachments.map((a) => el("li", { text: decodeURIComponent((a.uri?.spec ?? "").split("/").pop() || "Attachment") })))) : null,
      item.calendar?.readOnly ? null : el("div", { class: "mw-d-actions" },
        el("button", { class: "mw-d-edit", type: "button", text: "Edit", onclick: () => edit(item) }),
        el("button", { class: "mw-d-done", type: "button", text: item.isCompleted ? "Reopen" : "Mark done", onclick: () => void toggleDone(item) }),
        el("button", { class: "mw-d-delete", type: "button", text: "Delete", onclick: () => void remove(item) })),
    ].filter(Boolean));
  }

  function renderFilters() {
    const count = (key) => state.items.filter((t) => passes(t, key)).length;
    filters.replaceChildren(...FILTERS.map(([key, label, icon]) => el("button", { class: `mw-f-item mw-f-${key}${state.filter === key && state.view === "tasks" ? " active" : ""}`, type: "button",
      onclick: () => { state.filter = key; state.view = "tasks"; remember(); render(); } },
      el("span", { class: `mw-t-ico mw-i-${icon}` }), el("span", { class: "mw-f-label", text: label }), el("span", { class: "mw-f-count", text: String(count(key)) }))));
  }

  function render() {
    renderFilters();
    const segment = (value, label, icon) => el("button", { type: "button", class: "mw-seg-item", "aria-pressed": String(state.view === value), onclick: () => { state.view = value; remember(); render(); } }, el("span", { class: `mw-t-ico mw-i-${icon}` }), label);
    const status = (value, label) => el("button", { type: "button", class: "mw-seg-item", "aria-pressed": String(state.status === value), onclick: () => { state.status = value; render(); } }, label);
    const sortButton = el("button", { class: "mw-t-btn ghost", type: "button", onclick: () => menu(sortButton, [["Due date", () => { state.sort = "due"; remember(); render(); }], ["Priority", () => { state.sort = "priority"; remember(); render(); }], ["Title", () => { state.sort = "title"; remember(); render(); }]]) },
      el("span", { class: "mw-t-ico mw-i-sort" }), `Sort: ${{ due: "Due date", priority: "Priority", title: "Title" }[state.sort]}`);
    const create = el("div", { class: "mw-t-split" },
      el("button", { class: "mw-t-btn primary", type: "button", onclick: () => void (state.view === "plans" ? newPlan() : newTask()) }, el("span", { class: "mw-t-ico mw-i-add" }), state.view === "plans" ? "New plan" : "New task"),
      el("button", { class: "mw-t-btn primary caret", type: "button", title: "More", onclick: (event) => menu(event.currentTarget, [["New task", () => void newTask()], ["New task with all details…", () => window.createTodoWithDialog()], ["New plan", () => void newPlan()]]) }));
    const list = el("div", { class: "mw-t-list" });
    if (state.view === "plans") renderPlans(list); else renderTasks(list);
    const aside = el("aside", { class: "mw-t-details" });
    renderDetails(aside);
    const scroll = root.querySelector(".mw-t-list")?.scrollTop ?? 0;
    const focused = document.activeElement === search;
    root.replaceChildren(
      el("header", { class: "mw-t-head" },
        el("h1", { text: "Tasks" }),
        el("div", { class: "mw-seg" }, segment("plans", "Plans", "account_tree"), segment("tasks", "All tasks", "checklist")),
        el("span", { class: "mw-t-spacer" }),
        el("label", { class: "mw-t-search" }, el("span", { class: "mw-t-ico mw-i-search" }), search, el("kbd", { text: "Ctrl+K" }))),
      el("div", { class: "mw-t-bar" }, create, state.view === "tasks" ? el("div", { class: "mw-seg" }, status("all", "All"), status("open", "Open"), status("completed", "Completed")) : null, el("span", { class: "mw-t-spacer" }), sortButton),
      el("div", { class: "mw-t-body" }, list, aside));
    root.querySelector(".mw-t-list").scrollTop = scroll;
    if (focused) search.focus();
  }

  // --- data ----------------------------------------------------------------------------------
  let loading = null;
  async function load() {
    const composite = cal.view.getCompositeCalendar(window);
    const filter = Ci.calICalendar.ITEM_FILTER_TYPE_TODO | Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL;
    state.items = await composite.getItemsAsArray(filter, 0, null, null);
    if (state.selected && !state.items.some((t) => t.id === state.selected)) state.selected = null;
    render();
  }
  let timer = 0;
  const reload = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { loading = load().catch((error) => console.error("Mail Workspace: tasks", error)); }, 150); };
  const observer = {
    QueryInterface: ChromeUtils.generateQI(["calIObserver", "calICompositeObserver"]),
    onStartBatch() {}, onEndBatch() { reload(); }, onLoad() { reload(); }, onError() {}, onPropertyChanged() {}, onPropertyDeleting() {},
    onAddItem: reload, onModifyItem: reload, onDeleteItem: reload,
    onCalendarAdded: reload, onCalendarRemoved: reload, onDefaultCalendarChanged() {},
  };
  try { const composite = cal.view.getCompositeCalendar(window); composite.addObserver(observer); undo.push(() => composite.removeObserver(observer)); } catch (error) { console.error(error); }
  // The view is drawn when the task view is shown (and kept in step while it is).
  const shown = () => !box.hasAttribute("collapsed");
  const modeObserver = new window.MutationObserver(() => { panel.toggleAttribute("mw-tasks", shown()); if (shown()) reload(); });
  modeObserver.observe(box, { attributes: true, attributeFilter: ["collapsed"] });
  undo.push(() => modeObserver.disconnect());
  panel.toggleAttribute("mw-tasks", shown());
  reload();
  // Midnight moves tasks between groups.
  const tick = window.setInterval(() => { if (shown()) render(); }, 10 * 60 * 1000);
  undo.push(() => window.clearInterval(tick));
  void loading;

  return () => {
    for (const fn of undo) { try { fn(); } catch { /* gone */ } }
    for (const node of added) node.remove();
    panel.removeAttribute("mw-tasks");
    try { window.windowUtils.removeSheetUsingURIString(TASKS_SHEET, window.windowUtils.AUTHOR_SHEET); } catch { /* not loaded */ }
  };
}
