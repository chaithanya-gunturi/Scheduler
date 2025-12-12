// Local Scheduler (Final)
// - Stores daily text files (year/month/day.txt) in a chosen local folder (visible on disk).
// - Remembers folder permission using IndexedDB, restores silently on load.
// - Recurring events overlay at runtime (not saved into day.txt to avoid duplication).
// - Features: calendar, day view with checklists, recurring events CRUD,
//   background image, export/import zip, dark/light mode, help overlay.
// - Dividers removed; fixed widths handled by CSS.

const calendarEl = document.getElementById("calendar");
const dayViewEl = document.getElementById("day-view");
const dayTitleEl = document.getElementById("day-title");
const activitiesEl = document.getElementById("activities");
const addActivityBtn = document.getElementById("add-activity");
const saveDayBtn = document.getElementById("save-day");
const chooseFolderBtn = document.getElementById("choose-folder");
const prevMonthBtn = document.getElementById("prev-month");
const nextMonthBtn = document.getElementById("next-month");
const monthLabelEl = document.getElementById("month-label");
const exportZipBtn = document.getElementById("export-zip");
const importZipInput = document.getElementById("import-zip");
const helpBtn = document.getElementById("help-btn");
const helpOverlay = document.getElementById("help-overlay");
const helpClose = document.getElementById("help-close");
const themeToggle = document.getElementById("theme-toggle");

const recurringListEl = document.getElementById("recurring-list");
const addRecurringBtn = document.getElementById("add-recurring");
const recModal = document.getElementById("recurring-modal");
const recTitle = document.getElementById("rec-title");
const recTime = document.getElementById("rec-time");
const recType = document.getElementById("rec-type");
const recInterval = document.getElementById("rec-interval");
const recDow = document.getElementById("rec-dow");
const recDom = document.getElementById("rec-dom");
const recItems = document.getElementById("rec-items");
const recSave = document.getElementById("rec-save");
const recCancel = document.getElementById("rec-cancel");

const activityTemplate = document.getElementById("activity-template");
const weekViewEl = document.getElementById("week-view");

const recStart = document.getElementById("rec-start");
const recEnd = document.getElementById("rec-end");


const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const reminderLeadInput = document.getElementById("reminder-lead");
const notifyPermissionBtn = document.getElementById("notify-permission");
const todayBtn = document.getElementById("today-btn");


// ----- State -----
let dataDirHandle = null;
let currentDate = new Date();
let currentActivities = []; // only file contents; recurring overlay is separate
let currentFileHandle = null;

let recurringEvents = [];
let editingRecurringIndex = null;

const today = new Date();
let currentMonth = today.getMonth();
let currentYear = today.getFullYear();

// ----- Utility: render text with clickable links -----
function renderTextWithLinks(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}


// ----- Theme persistence -----
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light") document.body.classList.add("light-mode");
})();
themeToggle.onclick = () => {
  document.body.classList.toggle("light-mode");
  localStorage.setItem(
    "theme",
    document.body.classList.contains("light-mode") ? "light" : "dark"
  );
};

(function initReminderLead() {
  const saved = localStorage.getItem("reminderLead");
  if (saved) reminderLeadInput.value = parseInt(saved, 10);
})();
reminderLeadInput.onchange = () => {
  const v = Math.max(1, Math.min(120, parseInt(reminderLeadInput.value, 10) || 15));
  reminderLeadInput.value = v;
  localStorage.setItem("reminderLead", v);
};

notifyPermissionBtn.onclick = async () => {
  const res = await Notification.requestPermission();
  if (res === "granted") {
    showPopup("Notifications enabled.");
  } else {
    showPopup("Notifications not enabled.");
  }
};

// ===== IndexedDB helpers to persist folder handle =====
const DB_NAME = "scheduler-db";
const STORE_NAME = "handles";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(key, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ----- Today button -----
todayBtn.onclick = () => {
  const now = new Date();
  currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // strip time
  openDay(currentDate); // re-render day view
  renderCalendar(currentDate.getFullYear(), currentDate.getMonth()); // update calendar highlight

  // Disable button since we're now on today
  todayBtn.disabled = true;
};


// ----- Init folder (restore without prompting) -----
async function initFolder() {
  try {
    const storedHandle = await loadHandle("dataDirHandle");
    if (storedHandle) {
      const perm = await storedHandle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        dataDirHandle = storedHandle;
        await applyCustomBackground();
        await loadRecurring();
        renderCalendar(currentYear, currentMonth);
        return;
      }
    }
    // First run: prompt once
    dataDirHandle = await window.showDirectoryPicker();
    const perm = await dataDirHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      await saveHandle("dataDirHandle", dataDirHandle);
      await applyCustomBackground();
      await loadRecurring();
      renderCalendar(currentYear, currentMonth);
    } else {
      showPopup("Folder permission denied. Choose a data folder to proceed.");
    }
  } catch (err) {
    console.error("initFolder error:", err);
    showPopup("Unable to access local storage folder. Please choose a data folder.");
  }
  
}
initFolder();

// ----- Utilities -----
function parseTimeStr(str) {
  if (!str) return "";
  const m = str.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? str : "";
}

// ----- Parser/Saver for daily text files -----
// Format:
// Activity: 09:30 | Title here
// - [x] Task one
// - [ ] Task two
// (blank line between activities)
function parseActivities(text) {
  const lines = text.split("\n");
  const activities = [];
  const overrides = {};
  let current = null;
  let currentOverride = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("Activity:")) {
      // flush any previous activity before starting a new one
      if (current) {
        activities.push(current);
        current = null;
      }
      const payload = line.slice("Activity:".length).trim();
      const done = payload.endsWith("[x]");
      const clean = done ? payload.replace(/\s*\[x\]$/, "") : payload;
      const parts = clean.split("|");
      let time = "", title = clean;
      if (parts.length > 1) {
        time = parts[0].trim();
        title = parts.slice(1).join("|").trim();
      }
      current = { title, time, items: [], done, isRecurring: false };
      currentOverride = null;
      continue;
    }

    if (line.startsWith("RecurringOverride:")) {
      // flush any pending activity before switching to override
      if (current) {
        activities.push(current);
        current = null;
      }
      const payload = line.slice("RecurringOverride:".length).trim();
      const done = payload.endsWith("[x]");
      const recId = done ? payload.replace(/\s*\[x\]$/, "") : payload;
      currentOverride = { done, itemOverrides: [], itemState: {} };
      overrides[recId] = currentOverride;
      continue;
    }

    if (line.startsWith("-")) {
      const done = /\[x\]/.test(line);
      const itemText = line.replace(/- \[(x| )\]\s?/, "");
      if (current) {
        current.items.push({ text: itemText, done });
      } else if (currentOverride) {
        currentOverride.itemOverrides.push({ text: itemText, done });
      }
      continue;
    }

    if (line.startsWith("ItemState:")) {
      const payload = line.slice("ItemState:".length).trim();
      const [recId, key, state] = payload.split("|");
      if (!overrides[recId]) overrides[recId] = { done: false, itemOverrides: [], itemState: {} };
      overrides[recId].itemState[key] = (state.trim() === "x");
      continue;
    }
  }

  // flush last activity if still pending
  if (current) activities.push(current);

  const dateKey = currentDateKey();
  saveDayOverrides(dateKey, overrides);

  return activities;
}

function serializeActivities(activities) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  let out = "";

  // One-off activities
  for (const a of activities.filter(x => !x.isRecurring)) {
    const head = a.time ? `${a.time} | ${a.title}` : a.title;
    out += `Activity: ${head}${a.done ? " [x]" : ""}\n`;
    for (const i of a.items || []) {
      out += `- [${i.done ? "x" : " "}] ${i.text}\n`;
    }
    out += "\n";
  }

  // Recurring overrides
  for (const [recId, ov] of Object.entries(overrides)) {
    out += `RecurringOverride: ${recId}${ov.done ? " [x]" : ""}\n`;

    if (ov.itemOverrides) {
      for (const i of ov.itemOverrides) {
        out += `- [${i.done ? "x" : " "}] ${i.text}\n`;
      }
    }

    if (ov.itemState) {
      for (const [key, state] of Object.entries(ov.itemState)) {
        out += `ItemState: ${recId}|${key}|${state ? "x" : " "}\n`;
      }
    }

    out += "\n";
  }

  return out.trim() + "\n";
}

// Decide if a recurring template applies on a given dateKey (YYYY-MM-DD)
// Helpers
function toDate(dateKeyOrISO) {
  if (!dateKeyOrISO) return null;
  const d = new Date(dateKeyOrISO);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  const ms = toDate(b) - toDate(a);
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function weeksBetween(a, b) {
  return Math.floor(daysBetween(a, b) / 7);
}

function appliesOnDate(tpl, dateKey) {
  if (!tpl) return false;
  const rec = tpl.recurrence || {};
  const date = toDate(dateKey);
  const start = tpl.startDate ? toDate(tpl.startDate) : null;
  const end = tpl.endDate ? toDate(tpl.endDate) : null;
  const interval = Math.max(1, Number(rec.interval || 1));

  if (start && date < start) return false;
  if (end && date > end) return false;

  switch (rec.type) {
    case "daily": {
      const anchor = start || date;
      const diff = daysBetween(anchor, date);
      return diff % interval === 0;
    }
    case "weekly": {
      const targetDays = rec.daysOfWeek ?? (rec.dayOfWeek != null ? [rec.dayOfWeek] : []);
      if (!targetDays.includes(date.getDay())) return false;
      const anchor = start || date;
      const wdiff = weeksBetween(anchor, date);
      return wdiff % interval === 0;
    }
    case "monthly": {
      const targetDays = rec.daysOfMonth ?? (rec.dayOfMonth != null ? [rec.dayOfMonth] : []);
      if (!targetDays.includes(date.getDate())) return false;
      const monthsDiff =
        (date.getFullYear() - (start ? start.getFullYear() : date.getFullYear())) * 12 +
        (date.getMonth() - (start ? start.getMonth() : date.getMonth()));
      return monthsDiff % interval === 0;
    }
    default:
      return false;
  }
}

// ----- File helpers -----
async function applyCustomBackground() {
  if (!dataDirHandle) return;
  for (const name of ["background.jpg", "background.png"]) {
    try {
      const bgHandle = await dataDirHandle.getFileHandle(name, { create: false });
      const file = await bgHandle.getFile();
      const url = URL.createObjectURL(file);
      document.body.style.backgroundImage = `url(${url})`;
      document.body.style.backgroundSize = "cover";
      document.body.style.backgroundPosition = "center";
      document.body.style.backgroundAttachment = "fixed";
      return;
    } catch { /* try next */ }
  }
}

async function getDayFileHandle(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  const yearDir = await dataDirHandle.getDirectoryHandle(year, { create: true });
  const monthDir = await yearDir.getDirectoryHandle(month, { create: true });

  const filename = `${day}.txt`;
  try {
    return await monthDir.getFileHandle(filename, { create: false });
  } catch {
    const handle = await monthDir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(`# ${year}-${month}-${day}\n\n`);
    await writable.close();
    return handle;
  }
}

async function readDayFile(handle) {
  const file = await handle.getFile();
  return await file.text();
}

async function writeDayFile(handle, activities) {
  const text = serializeActivities(activities);
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}


// ----- Auto-save helper with debounce -----
let saveTimeout; // holds the timer ID

function showSaveStatus() {
  const status = document.getElementById("save-status");
  const bar = document.getElementById("status-bar");
  const now = new Date().toLocaleTimeString();
  status.textContent = `💾 Saved at ${now}`;
  bar.style.opacity = "1";
  setTimeout(() => bar.style.opacity = "0", 2000); // fade out after 2s
}


async function autoSaveDay() {
  if (!currentFileHandle) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      const display = buildDisplayActivities(); // merge one-offs + recurring overrides
      await writeDayFile(currentFileHandle, display);
      showSaveStatus();
    } catch (err) {
      console.error("Auto-save failed:", err);
    }
  }, 500);
}


// ----- Recurring storage -----
async function loadRecurring() {
  if (!dataDirHandle) { recurringEvents = []; return; }
  try {
    const handle = await dataDirHandle.getFileHandle("recurring.json", { create: true });
    const file = await handle.getFile();
    const text = await file.text();
    recurringEvents = JSON.parse(text || "[]");
  } catch {
    recurringEvents = [];
  }

  // Normalize legacy recurring entries to include id and recurrence object
  recurringEvents = recurringEvents.map((ev, i) => {
    const id = ev.id || `rec_${i}_${(ev.title || "untitled").toLowerCase().replace(/\s+/g, "_")}`;
    const recurrence = ev.recurrence || {
      type: ev.type || "weekly",
      interval: ev.interval || 1,
      dayOfWeek: ev.dayOfWeek ?? null,
      dayOfMonth: ev.dayOfMonth ?? null
    };
    // Normalize items to objects
    const items = Array.isArray(ev.items)
      ? ev.items.map(it => (typeof it === "string" ? { id: null, text: it } : it))
      : [];
    return { ...ev, id, recurrence, items };
  });

  renderRecurring();
}

async function saveRecurring() {
  const handle = await dataDirHandle.getFileHandle("recurring.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(recurringEvents, null, 2));
  await writable.close();
  renderRecurring();
}

// ----- Recurring matching (overlay only) -----
function matchesRecurring(ev, date) {
  const iso = date.toISOString().slice(0,10);

  // Respect start/end bounds
  if (ev.startDate && iso < ev.startDate) return false;
  if (ev.endDate && iso > ev.endDate) return false;

  const dow = date.getDay();
  const dom = date.getDate();

  if (ev.type === "daily") {
    const anchor = new Date(ev.startDate || "2020-01-01");
    const daysDiff = Math.floor((date - anchor) / (1000 * 60 * 60 * 24));
    return daysDiff % (ev.interval || 1) === 0;
  }

  if (ev.type === "weekly") {
    if (dow !== ev.dayOfWeek) return false;
    const anchor = new Date(ev.startDate || "2020-01-01");
    const weeksDiff = Math.floor((date - anchor) / (1000 * 60 * 60 * 24 * 7));
    return weeksDiff % (ev.interval || 1) === 0;
  }

  if (ev.type === "monthly") {
    if (dom !== ev.dayOfMonth) return false;
    const anchor = new Date(ev.startDate || "2020-01-01");
    const monthsDiff =
      (date.getFullYear() - anchor.getFullYear()) * 12 +
      (date.getMonth() - anchor.getMonth());
    return monthsDiff % (ev.interval || 1) === 0;
  }

  return false;
}

function scheduleRemindersForDate(date) {
  const leadMin = parseInt(localStorage.getItem("reminderLead") || "15", 10);
  if (Notification.permission !== "granted") return;

  recurringEvents.forEach(ev => {
    if (!ev.time) return;
    if (!matchesRecurring(ev, date)) return;

    const [h, m] = ev.time.split(":").map(Number);
    const eventTime = new Date(date);
    eventTime.setHours(h, m, 0, 0);

    const reminderTime = new Date(eventTime.getTime() - leadMin * 60 * 1000);
    const delay = reminderTime.getTime() - Date.now();

    if (delay > 0) {
      setTimeout(() => {
        new Notification("Upcoming event", {
          body: `${ev.title} at ${ev.time}`,
          tag: `recurring-${ev.title}-${ev.time}`
        });
      }, delay);
    }
  });
}

function scheduleRemindersForActivities(date) {
  const leadMin = parseInt(localStorage.getItem("reminderLead") || "15", 10);
  if (Notification.permission !== "granted") return;

  currentActivities.forEach(act => {
    if (!act.time) return; // skip untimed
    if (act.isRecurring) return; // skip recurring (already handled separately)

    const [h, m] = act.time.split(":").map(Number);
    const eventTime = new Date(date);
    eventTime.setHours(h, m, 0, 0);

    const reminderTime = new Date(eventTime.getTime() - leadMin * 60 * 1000);
    const delay = reminderTime.getTime() - Date.now();

    if (delay > 0) {
      setTimeout(() => {
        new Notification("Upcoming activity", {
          body: `${act.title} at ${act.time}`,
          tag: `activity-${act.title}-${act.time}`
        });
      }, delay);
    }
  });
}

// ----- Calendar rendering -----
function renderCalendar(year, month) {
  calendarEl.innerHTML = "";

  // Top bar: month/year + navigation buttons
  const topBar = document.createElement("div");
  topBar.className = "calendar-topbar";

  const prevBtn = document.createElement("button");
  prevBtn.className = "calendar-nav prev";
  prevBtn.textContent = "◀";
  prevBtn.onclick = () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderCalendar(currentYear, currentMonth);
  };

  const nextBtn = document.createElement("button");
  nextBtn.className = "calendar-nav next";
  nextBtn.textContent = "▶";
  nextBtn.onclick = () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    renderCalendar(currentYear, currentMonth);
  };

  const title = document.createElement("div");
  title.className = "calendar-title";
  title.textContent = new Date(year, month, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });

  topBar.appendChild(prevBtn);
  topBar.appendChild(title);
  topBar.appendChild(nextBtn);
  calendarEl.appendChild(topBar);

  // Weekday header row
  const header = document.createElement("div");
  header.className = "calendar-header";
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (const w of weekdays) {
    const wd = document.createElement("div");
    wd.className = "calendar-weekday";
    wd.textContent = w;
    header.appendChild(wd);
  }
  calendarEl.appendChild(header);

  // Grid container
  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = ((firstOfMonth.getDay() + 6) % 7); // Monday=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Empty cells before the 1st
  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement("div");
    empty.className = "calendar-day empty";
    grid.appendChild(empty);
  }

 // Actual days
const today = new Date();
for (let d = 1; d <= daysInMonth; d++) {
  const date = new Date(year, month, d);
  const dayEl = document.createElement("div");
  dayEl.className = "calendar-day";
  dayEl.textContent = d;

  // Mark past dates
  if (date < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    dayEl.classList.add("past-day");
  }

  // Highlight today
  if (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  ) {
    dayEl.classList.add("today-cell");
  }

  // Highlight the currently selected day
  if (
    currentDate &&
    date.getDate() === currentDate.getDate() &&
    date.getMonth() === currentDate.getMonth() &&
    date.getFullYear() === currentDate.getFullYear()
  ) {
    dayEl.classList.add("selected-day");
  }

  dayEl.onclick = () => {
    currentDate = date;
    openDay(date); // show day view
    renderCalendar(year, month); // refresh highlight
  };

  grid.appendChild(dayEl);
}

  calendarEl.appendChild(grid);
}


function showDayView() {
  dayViewEl.classList.remove("hidden");
  weekViewEl.classList.add("hidden");
}
function showWeekView() {
  weekViewEl.classList.remove("hidden");
  dayViewEl.classList.add("hidden");
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  d.setDate(d.getDate() - diffToMonday);
  d.setHours(0,0,0,0);
  return d;
}


function deleteRecurringOverrideItem(recurringId, itemIdx) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const ov = overrides[recurringId] || {};
  if (ov.itemOverrides) {
    ov.itemOverrides.splice(itemIdx, 1);
  }
  overrides[recurringId] = ov;
  saveDayOverrides(dateKey, overrides);
  autoSaveDay();
}


let currentWeekStart = null;


// ----- Day view (overlay recurring only for display) -----
async function openDay(date) {
  if (!dataDirHandle) {
    showPopup("Choose a data folder first.");
    return;
  }

  // Animate fade-out before switching
  dayViewEl.classList.add("fade-out");

  setTimeout(async () => {
    currentDate = date;
    dayTitleEl.textContent = date.toDateString();
    dayViewEl.classList.remove("hidden");

    currentFileHandle = await getDayFileHandle(date);
    const text = await readDayFile(currentFileHandle);
    currentActivities = parseActivities(text);

    // Build display list with overlayed recurring (no persistence)
    const displayActivities = buildDisplayActivities();
    renderActivities(displayActivities);
    //console.table(displayActivities.map(a => ({ time: a.time || "", title: a.title, isRecurring: !!a.isRecurring })));

    const today = new Date();
    if (today.toDateString() === date.toDateString()) {
      scheduleRemindersForDate(today);
      scheduleRemindersForActivities(today);
    }

    // Toggle Today button state
    const isToday =
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();

    if (typeof todayBtn !== "undefined" && todayBtn) {
      todayBtn.disabled = isToday;
    }

    // Trigger fade-in + scale-in after content refresh
    dayViewEl.classList.remove("fade-out");
    dayViewEl.classList.add("fade-in");

    // Remove fade-in class after animation completes
    setTimeout(() => dayViewEl.classList.remove("fade-in"), 300);
  }, 200); // wait 200ms for fade-out
}

async function renderWeekView(startDate) {
  if (!dataDirHandle) {
    showPopup("Choose a data folder first.");
    return;
  }
  weekViewEl.innerHTML = "";

  for (let i = 0; i < 7; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);

    const fileHandle = await getDayFileHandle(date);
    const text = await readDayFile(fileHandle);
    const activities = parseActivities(text);

    const display = [...activities];
    recurringEvents.forEach(ev => {
      if (matchesRecurring(ev, date)) {
        display.push({
          title: ev.title,
          time: ev.time,
          items: (ev.items || []).map(t => ({ text: t, done: false }))
        });
      }
    });

    display.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

    const dayCol = document.createElement("div");
    dayCol.className = "week-day";
    dayCol.innerHTML = `<h4>${date.toDateString()}</h4>`;
    display.forEach(a => {
      const row = document.createElement("div");
      row.className = "week-item";
      row.textContent = `${a.time ? a.time + " • " : ""}${a.title}`;
      dayCol.appendChild(row);
    });
    weekViewEl.appendChild(dayCol);
  }
}

function buildDisplayActivities() {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const out = [];

  // One-off activities
  for (const act of currentActivities) {
    out.push({ ...act, isRecurring: false });
  }

  // Recurring instances
  if (!Array.isArray(recurringEvents)) return out;

  for (const tpl of recurringEvents) {
    if (!tpl || !tpl.id) continue;
    if (!appliesOnDate(tpl, dateKey)) continue;

    const ov = overrides[tpl.id] || {};
    const done = !!ov.done;

    const items = [];
    const itemState = ov.itemState || {};

    (tpl.items || []).forEach((item, idx) => {
      const key = item && item.id ? item.id : `tplItem_${idx}`;
      const dayDone = key in itemState ? itemState[key] : false;
      items.push({
        text: item ? item.text : "",
        done: done ? true : dayDone,
        _key: key,
        _fromTpl: true
      });
    });

    (ov.itemOverrides || []).forEach((ovItem, idx) => {
      items.push({
        text: ovItem.text,
        done: done ? true : !!ovItem.done,
        _fromOverride: true,
        _overrideIdx: idx
      });
    });

    out.push({
      id: tpl.id,
      title: tpl.title || "(Recurring)",
      time: tpl.time || "",
      items,
      done,
      isRecurring: true
    });
  }

  return out;
}



// Returns the current date key in YYYY-MM-DD format
function currentDateKey(date = currentDate || new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDayOverrides(dateKey) {
  const raw = localStorage.getItem(`dayOverrides:${dateKey}`);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function saveDayOverrides(dateKey, obj) {
  localStorage.setItem(`dayOverrides:${dateKey}`, JSON.stringify(obj));
}

// Generic modal for a single text input
function openSimpleInputModal(labelText, onSave) {
  const modal = document.createElement("div");
  modal.className = "edit-modal";

  const form = document.createElement("div");
  form.className = "edit-form";

  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  label.appendChild(input);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.onclick = () => {
    const val = input.value.trim();
    if (val) onSave(val);
    document.body.removeChild(modal);
  };

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => {
    document.body.removeChild(modal);
  };

  form.appendChild(label);
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  modal.appendChild(form);
  document.body.appendChild(modal);

  input.focus();
}


// ----- Activities rendering -----
function renderActivities(displayActivities) {
  const container = document.getElementById("activities");
  container.innerHTML = "";

  // Sort by time; untimed last
  displayActivities.sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  const hourBlocks = new Map();
  let noTimeBlockEl = null;

  function ensureHourBlock(hourStr) {
    if (hourBlocks.has(hourStr)) return hourBlocks.get(hourStr);

    const block = document.createElement("div");
    block.className = "hour-block";

    const headerRow = document.createElement("div");
    headerRow.className = "hour-header-row";

    const label = document.createElement("h3");
    label.textContent = `${hourStr}:00`;

    const addBtn = document.createElement("button");
    addBtn.textContent = "➕";
    addBtn.className = "add-hour-btn";
    addBtn.title = "Add activity at this hour";
    addBtn.onclick = () => {
      openSimpleInputModal("Activity title:", (title) => {
        if (!title) return;
        currentActivities.push({
          id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
          title,
          time: `${hourStr.padStart(2,"0")}:00`,
          items: [],
          done: false,
          isRecurring: false
        });
        autoSaveDay();
        renderActivities(buildDisplayActivities());
      });
    };

    headerRow.appendChild(label);
    headerRow.appendChild(addBtn);
    block.appendChild(headerRow);
    container.appendChild(block);

    hourBlocks.set(hourStr, block);
    return block;
  }

  function ensureNoTimeBlock() {
    if (noTimeBlockEl) return noTimeBlockEl;
    noTimeBlockEl = document.createElement("div");
    noTimeBlockEl.className = "hour-block no-time";
    const label = document.createElement("h3");
    label.textContent = "No Time";
    noTimeBlockEl.appendChild(label);
    container.appendChild(noTimeBlockEl);
    return noTimeBlockEl;
  }

  displayActivities.forEach(act => {
    const activityDiv = document.createElement("div");
    activityDiv.className = "activity " + (act.isRecurring ? "recurring" : "oneoff");
    if (act.done) activityDiv.classList.add("done");

    const header = document.createElement("div");
    header.className = "activity-header";

    const activityCb = document.createElement("input");
    activityCb.type = "checkbox";
    activityCb.checked = !!act.done;
    activityCb.title = "Mark activity as done";
    activityCb.onchange = () => {
      if (act.isRecurring) {
        toggleRecurringDoneForDay(act.id, activityCb.checked);
      } else {
        act.done = activityCb.checked;
        if (act.done) (act.items || []).forEach(i => i.done = true);
        autoSaveDay();
      }
      renderActivities(buildDisplayActivities());
    };
    header.appendChild(activityCb);

    const timeEl = document.createElement("span");
    timeEl.className = "activity-time";
    timeEl.textContent = act.time || "";
    header.appendChild(timeEl);

    const titleEl = document.createElement("span");
    titleEl.className = "activity-title";
    titleEl.innerHTML = renderTextWithLinks(act.title);
    header.appendChild(titleEl);

    if (act.isRecurring) {
      const recurringLabel = document.createElement("span");
      recurringLabel.className = "recurring-label";
      recurringLabel.textContent = "🔁 Recurring";
      header.appendChild(recurringLabel);
    }

    activityDiv.appendChild(header);

    // Checklist
    const checklist = document.createElement("ul");
    (act.items || []).forEach((item, itemIdx) => {
      const li = document.createElement("li");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!item.done;
      cb.onchange = () => {
        if (act.isRecurring && item._fromTpl) {
          setRecurringItemDoneForDay(act.id, item._key, cb.checked);
        } else if (act.isRecurring && item._fromOverride) {
          updateRecurringOverrideItem(act.id, itemIdx, cb.checked);
        } else {
          item.done = cb.checked;
          autoSaveDay();
        }
        renderActivities(buildDisplayActivities());
      };
      li.appendChild(cb);

      const span = document.createElement("span");
      span.innerHTML = " " + renderTextWithLinks(item.text);
      li.appendChild(span);

      // Delete button logic
      if (!act.isRecurring) {
        const delItemBtn = document.createElement("button");
        delItemBtn.textContent = "🗑";
        delItemBtn.title = "Delete item";
        delItemBtn.onclick = () => {
          act.items.splice(itemIdx, 1);
          autoSaveDay();
          renderActivities(buildDisplayActivities());
        };
        li.appendChild(delItemBtn);
      } else if (item._fromOverride) {
        const delItemBtn = document.createElement("button");
        delItemBtn.textContent = "🗑";
        delItemBtn.title = "Delete override item";
        delItemBtn.onclick = () => {
          deleteRecurringOverrideItem(act.id, itemIdx);
          renderActivities(buildDisplayActivities());
        };
        li.appendChild(delItemBtn);
      }

      checklist.appendChild(li);
    });
    activityDiv.appendChild(checklist);

    // Controls
    if (!act.isRecurring) {
      const editBtn = document.createElement("button");
      editBtn.textContent = "✏️ Edit";
      editBtn.onclick = () => {
        openEditModal(act, () => {
          autoSaveDay();
          renderActivities(buildDisplayActivities());
        });
      };
      activityDiv.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.textContent = "🗑️ Delete";
      delBtn.onclick = () => {
        // Find by id if present, else by title+time
        const i = currentActivities.findIndex(a =>
          (a.id && act.id && a.id === act.id) ||
          (!a.id && a.title === act.title && a.time === act.time)
        );
        if (i !== -1) {
          currentActivities.splice(i, 1);
          autoSaveDay();
          renderActivities(buildDisplayActivities());
        }
      };
      activityDiv.appendChild(delBtn);

      const addItemBtn = document.createElement("button");
      addItemBtn.textContent = "➕ Add Item";
      addItemBtn.onclick = () => {
        openSimpleInputModal("New checklist item:", (val) => {
          if (!val) return;
          act.items.push({ text: val.trim(), done: false });
          autoSaveDay();
          renderActivities(buildDisplayActivities());
        });
      };
      activityDiv.appendChild(addItemBtn);
    } else {
      const addItemBtn = document.createElement("button");
      addItemBtn.textContent = "➕ Add Item (today)";
      addItemBtn.onclick = () => {
        openSimpleInputModal("New checklist item:", (val) => {
          if (!val) return;
          addItemToRecurringInstance(act.id, val.trim());
          renderActivities(buildDisplayActivities());
        });
      };
      activityDiv.appendChild(addItemBtn);
    }

    // Append to correct block
    if (act.time) {
      const hour = act.time.split(":")[0];
      const block = ensureHourBlock(hour);
      block.appendChild(activityDiv);
    } else {
      const block = ensureNoTimeBlock();
      block.appendChild(activityDiv);
    }
  });
}

async function persistOverridesForDate(dateKey) {
  if (!currentFileHandle) return;
  const display = buildDisplayActivities();
  const text = serializeActivities(display);
  const writable = await currentFileHandle.createWritable();
  await writable.write(text);
  await writable.close();
  showSaveStatus && showSaveStatus();
}

function toggleRecurringDoneForDay(recurringId, checked) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const ov = overrides[recurringId] || {};
  ov.done = checked;
  overrides[recurringId] = ov;
  saveDayOverrides(dateKey, overrides);
  autoSaveDay(); // triggers merged save
}

function setRecurringItemDoneForDay(recurringId, itemKey, checked) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const ov = overrides[recurringId] || {};
  ov.itemState = ov.itemState || {};
  ov.itemState[itemKey] = checked;
  overrides[recurringId] = ov;
  saveDayOverrides(dateKey, overrides);
  persistOverridesForDate(dateKey);
}

function updateRecurringOverrideItem(recurringId, itemIdx, checked) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const ov = overrides[recurringId] || {};
  if (ov.itemOverrides && ov.itemOverrides[itemIdx]) {
    ov.itemOverrides[itemIdx].done = checked;
  }
  overrides[recurringId] = ov;
  saveDayOverrides(dateKey, overrides);
  persistOverridesForDate(dateKey);
}

function addItemToRecurringInstance(recurringId, text) {
  const dateKey = currentDateKey();
  const overrides = getDayOverrides(dateKey) || {};
  const ov = overrides[recurringId] || {};
  ov.itemOverrides = ov.itemOverrides || [];
  ov.itemOverrides.push({ text, done: false });
  overrides[recurringId] = ov;
  saveDayOverrides(dateKey, overrides);
  persistOverridesForDate(dateKey);
}


// Helper: render a single activity card with full controls
function renderActivityCard(act) {
  const activityDiv = document.createElement("div");
  activityDiv.className = "activity";

  // Header: time + title + recurring label
  const header = document.createElement("div");
  header.className = "activity-header";

  const timeEl = document.createElement("span");
  timeEl.className = "activity-time";
  timeEl.textContent = act.time || "";
  header.appendChild(timeEl);

  const titleEl = document.createElement("span");
  titleEl.className = "activity-title";
  titleEl.innerHTML = renderTextWithLinks(act.title);
  header.appendChild(titleEl);

  if (act.isRecurring) {
    const recurringLabel = document.createElement("span");
    recurringLabel.className = "recurring-label";
    recurringLabel.textContent = "🔁 Recurring";
    header.appendChild(recurringLabel);
  }

  activityDiv.appendChild(header);

  // Checklist with delete child item
  const checklist = document.createElement("ul");
  (act.items || []).forEach((item, itemIdx) => {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      autoSaveDay();
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(cb);

    const span = document.createElement("span");
    span.innerHTML = " " + renderTextWithLinks(item.text);
    li.appendChild(span);

    const delItemBtn = document.createElement("button");
    delItemBtn.className = "btn-icon";
    delItemBtn.textContent = "🗑";
    delItemBtn.title = "Delete item";
    delItemBtn.onclick = () => {
      act.items.splice(itemIdx, 1);
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(delItemBtn);

    checklist.appendChild(li);
  });
  activityDiv.appendChild(checklist);

  // Controls bar (explicit, visible)
  const controls = document.createElement("div");
  controls.className = "activity-controls";

  // For recurring overlay items, we show disabled controls (informative)
  const isOverlay = !!act.isRecurring;

  const editBtn = document.createElement("button");
  editBtn.textContent = "✏️ Edit";
  editBtn.disabled = isOverlay;
  editBtn.title = isOverlay ? "Edit real activities only" : "Edit activity";
  editBtn.onclick = () => {
    const newTitle = prompt("New title?", act.title);
    if (newTitle) act.title = newTitle;
    autoSaveDay();
    renderActivities(buildDisplayActivities());
    activityDiv.classList.add("activity-updated");
    setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
  };
  controls.appendChild(editBtn);

  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑️ Delete";
  delBtn.disabled = isOverlay;
  delBtn.title = isOverlay ? "Delete real activities only" : "Delete activity";
  delBtn.onclick = () => {
    const i = currentActivities.findIndex(a => a === act);
    if (i !== -1) {
      currentActivities.splice(i, 1);
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    }
  };
  controls.appendChild(delBtn);

  const addItemBtn = document.createElement("button");
  addItemBtn.textContent = "➕ Add item";
  addItemBtn.disabled = false; // allow adding items to both; overlay items won't persist to file
  addItemBtn.title = isOverlay
    ? "Adds to display only (recurring overlay)"
    : "Add checklist item";
  addItemBtn.onclick = () => {
    const newItem = prompt("New checklist item?");
    if (newItem) {
      act.items = act.items || [];
      act.items.push({ text: newItem, done: false });
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    }
  };
  controls.appendChild(addItemBtn);

  activityDiv.appendChild(controls);

  return activityDiv;
}

// Helper: render a single activity card with full controls
function renderActivityCard(act) {
  const activityDiv = document.createElement("div");
  activityDiv.className = "activity";

  // Header: time + title + recurring label
  const header = document.createElement("div");
  header.className = "activity-header";

  const timeEl = document.createElement("span");
  timeEl.className = "activity-time";
  timeEl.textContent = act.time || "";
  header.appendChild(timeEl);

  const titleEl = document.createElement("span");
  titleEl.className = "activity-title";
  titleEl.innerHTML = renderTextWithLinks(act.title);
  header.appendChild(titleEl);

  if (act.isRecurring) {
    const recurringLabel = document.createElement("span");
    recurringLabel.className = "recurring-label";
    recurringLabel.textContent = "🔁 Recurring";
    header.appendChild(recurringLabel);
  }

  activityDiv.appendChild(header);

  // Checklist with delete child item
  const checklist = document.createElement("ul");
  act.items.forEach((item, itemIdx) => {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      autoSaveDay();
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(cb);

    const span = document.createElement("span");
    span.innerHTML = " " + renderTextWithLinks(item.text);
    li.appendChild(span);

    // Delete checklist item
    const delItemBtn = document.createElement("button");
    delItemBtn.textContent = "🗑";
    delItemBtn.title = "Delete item";
    delItemBtn.onclick = () => {
      act.items.splice(itemIdx, 1);
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(delItemBtn);

    checklist.appendChild(li);
  });
  activityDiv.appendChild(checklist);

  // Controls only for non-recurring items
  if (!act.isRecurring) {
    const editBtn = document.createElement("button");
    editBtn.textContent = "✏️ Edit";
    editBtn.onclick = () => {
      const newTitle = prompt("New title?", act.title);
      if (newTitle) act.title = newTitle;
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    activityDiv.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑️ Delete";
    delBtn.onclick = () => {
      // Safe delete using object reference in currentActivities
      const i = currentActivities.findIndex(a => a === act);
      if (i !== -1) {
        currentActivities.splice(i, 1);
        autoSaveDay();
        renderActivities(buildDisplayActivities());
        activityDiv.classList.add("activity-updated");
        setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
      }
    };
    activityDiv.appendChild(delBtn);

    const addItemBtn = document.createElement("button");
    addItemBtn.textContent = "➕ Add Item";
    addItemBtn.onclick = () => {
      const newItem = prompt("New checklist item?");
      if (newItem) {
        act.items.push({ text: newItem, done: false });
        autoSaveDay();
        renderActivities(buildDisplayActivities());
        activityDiv.classList.add("activity-updated");
        setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
      }
    };
    activityDiv.appendChild(addItemBtn);
  }

  return activityDiv;
}

// Helper: render a single activity card with full controls
function renderActivityCard(act) {
  const activityDiv = document.createElement("div");
  activityDiv.className = "activity";

  // Header: time + title + recurring label
  const header = document.createElement("div");
  header.className = "activity-header";

  const timeEl = document.createElement("span");
  timeEl.className = "activity-time";
  timeEl.textContent = act.time || "";
  header.appendChild(timeEl);

  const titleEl = document.createElement("span");
  titleEl.className = "activity-title";
  titleEl.innerHTML = renderTextWithLinks(act.title);
  header.appendChild(titleEl);

  if (act.isRecurring) {
    const recurringLabel = document.createElement("span");
    recurringLabel.className = "recurring-label";
    recurringLabel.textContent = "🔁 Recurring";
    header.appendChild(recurringLabel);
  }

  activityDiv.appendChild(header);

  // Checklist with delete child item
  const checklist = document.createElement("ul");
  act.items.forEach((item, itemIdx) => {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      autoSaveDay();
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(cb);

    const span = document.createElement("span");
    span.innerHTML = " " + renderTextWithLinks(item.text);
    li.appendChild(span);

    // 🗑 Delete child item button
    const delItemBtn = document.createElement("button");
    delItemBtn.textContent = "🗑";
    delItemBtn.title = "Delete item";
    delItemBtn.onclick = () => {
      act.items.splice(itemIdx, 1);
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(delItemBtn);

    checklist.appendChild(li);
  });
  activityDiv.appendChild(checklist);

  // Buttons only for non-recurring activities
  if (!act.isRecurring) {
    const editBtn = document.createElement("button");
    editBtn.textContent = "✏️ Edit";
    editBtn.onclick = () => {
      const newTitle = prompt("New title?", act.title);
      if (newTitle) act.title = newTitle;
      autoSaveDay();
      renderActivities(buildDisplayActivities());
    };
    activityDiv.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑️ Delete";
    delBtn.onclick = () => {
      const i = currentActivities.findIndex(a => a === act);
      if (i !== -1) {
        currentActivities.splice(i, 1);
        autoSaveDay();
        renderActivities(buildDisplayActivities());
      }
    };
    activityDiv.appendChild(delBtn);

    const addItemBtn = document.createElement("button");
    addItemBtn.textContent = "➕ Add Item";
    addItemBtn.onclick = () => {
      const newItem = prompt("New checklist item?");
      if (newItem) {
        act.items.push({ text: newItem, done: false });
        autoSaveDay();
        renderActivities(buildDisplayActivities());
      }
    };
    activityDiv.appendChild(addItemBtn);
  }

  return activityDiv;
}

// Helper: render a single activity card with full controls
function renderActivityCard(act) {
  const activityDiv = document.createElement("div");
  activityDiv.className = "activity";

  // Header: time + title + recurring label
  const header = document.createElement("div");
  header.className = "activity-header";

  const timeEl = document.createElement("span");
  timeEl.className = "activity-time";
  timeEl.textContent = act.time || "";
  header.appendChild(timeEl);

  const titleEl = document.createElement("span");
  titleEl.className = "activity-title";
  titleEl.innerHTML = renderTextWithLinks(act.title);
  header.appendChild(titleEl);

  if (act.isRecurring) {
    const recurringLabel = document.createElement("span");
    recurringLabel.className = "recurring-label";
    recurringLabel.textContent = "🔁 Recurring";
    header.appendChild(recurringLabel);
  }

  activityDiv.appendChild(header);

  // Checklist with delete child item
  const checklist = document.createElement("ul");
  act.items.forEach((item, itemIdx) => {
    const li = document.createElement("li");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      autoSaveDay();
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(cb);

    const span = document.createElement("span");
    span.innerHTML = " " + renderTextWithLinks(item.text);
    li.appendChild(span);

    // 🗑 Delete child item button
    const delItemBtn = document.createElement("button");
    delItemBtn.textContent = "🗑";
    delItemBtn.title = "Delete item";
    delItemBtn.onclick = () => {
      act.items.splice(itemIdx, 1);
      autoSaveDay();
      renderActivities(buildDisplayActivities());
      activityDiv.classList.add("activity-updated");
      setTimeout(() => activityDiv.classList.remove("activity-updated"), 1000);
    };
    li.appendChild(delItemBtn);

    checklist.appendChild(li);
  });
  activityDiv.appendChild(checklist);

  // Buttons only for non-recurring activities
  if (!act.isRecurring) {
    const editBtn = document.createElement("button");
    editBtn.textContent = "✏️ Edit";
    editBtn.onclick = () => {
      const newTitle = prompt("New title?", act.title);
      if (newTitle) act.title = newTitle;
      autoSaveDay();
      renderActivities(buildDisplayActivities());
    };
    activityDiv.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑️ Delete";
    delBtn.onclick = () => {
      const i = currentActivities.findIndex(a => a === act);
      if (i !== -1) {
        currentActivities.splice(i, 1);
        autoSaveDay();
        renderActivities(buildDisplayActivities());
      }
    };
    activityDiv.appendChild(delBtn);

    const addItemBtn = document.createElement("button");
    addItemBtn.textContent = "➕ Add Item";
    addItemBtn.onclick = () => {
      const newItem = prompt("New checklist item?");
      if (newItem) {
        act.items.push({ text: newItem, done: false });
        autoSaveDay();
        renderActivities(buildDisplayActivities());
      }
    };
    activityDiv.appendChild(addItemBtn);
  }

  return activityDiv;
}

// Helper: render a single activity card (reuse your existing logic)
function renderActivityCard(act) {
  const activityDiv = document.createElement("div");
  activityDiv.className = "activity";

  const header = document.createElement("div");
  header.className = "activity-header";

  const timeEl = document.createElement("span");
  timeEl.className = "activity-time";
  timeEl.textContent = act.time || "";
  header.appendChild(timeEl);

  const titleEl = document.createElement("span");
  titleEl.className = "activity-title";
  titleEl.innerHTML = renderTextWithLinks(act.title);
  header.appendChild(titleEl);

  if (act.isRecurring) {
    const recurringLabel = document.createElement("span");
    recurringLabel.className = "recurring-label";
    recurringLabel.textContent = "🔁 Recurring";
    header.appendChild(recurringLabel);
  }

  activityDiv.appendChild(header);

  // Checklist
  const checklist = document.createElement("ul");
  act.items.forEach(item => {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.onchange = () => {
      item.done = cb.checked;
      autoSaveDay();
    };
    li.appendChild(cb);

    const span = document.createElement("span");
    span.innerHTML = " " + renderTextWithLinks(item.text);
    li.appendChild(span);

    checklist.appendChild(li);
  });
  activityDiv.appendChild(checklist);

  return activityDiv;
}



addActivityBtn.onclick = () => {
  // Create modal
  const modal = document.createElement("div");
  modal.className = "edit-modal";

  const form = document.createElement("div");
  form.className = "edit-form";

  // Title input
  const titleLabel = document.createElement("label");
  titleLabel.textContent = "Title:";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.placeholder = "Activity title";
  titleLabel.appendChild(titleInput);

  // Time input
  const timeLabel = document.createElement("label");
  timeLabel.textContent = "Time:";
  const timeInput = document.createElement("input");
  timeInput.type = "time";
  timeLabel.appendChild(timeInput);

  // Items input
  const itemsLabel = document.createElement("label");
  itemsLabel.textContent = "Checklist items (comma separated):";
  const itemsInput = document.createElement("input");
  itemsInput.type = "text";
  itemsInput.placeholder = "e.g. task1, task2";
  itemsLabel.appendChild(itemsInput);

  // Save button
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Add Activity";
  saveBtn.onclick = () => {
    const title = titleInput.value.trim();
    if (!title) { alert("Title is required"); return; }

    const time = parseTimeStr(timeInput.value);
    const items = itemsInput.value.split(",").map(s => s.trim()).filter(Boolean)
      .map(t => ({ text: t, done: false }));

    currentActivities.push({ title, time, items });
    autoSaveDay();
    renderActivities(buildDisplayActivities());
    document.body.removeChild(modal);
  };

  // Cancel button
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => {
    document.body.removeChild(modal);
  };

  form.appendChild(titleLabel);
  form.appendChild(timeLabel);
  form.appendChild(itemsLabel);
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);

  modal.appendChild(form);
  document.body.appendChild(modal);
};



// ----- Export/Import (recursive for hierarchy) -----
async function zipDirectory(dirHandle, zipFolder) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      const text = await file.text();
      zipFolder.file(entry.name, text);
    } else if (entry.kind === "directory") {
      const subZip = zipFolder.folder(entry.name);
      await zipDirectory(entry, subZip);
    }
  }
}

// Toggle overlay
settingsBtn.onclick = () => {
  settingsOverlay.classList.add("active");
};
settingsClose.onclick = () => {
  settingsOverlay.classList.remove("active");
};

exportZipBtn.onclick = async () => {
  if (!dataDirHandle) {
    showPopup("Choose your data folder first.");
    return;
  }
  const zip = new JSZip();
  await zipDirectory(dataDirHandle, zip);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scheduler_backup.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showPopup("Exported.");
};

importZipInput.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!dataDirHandle) {
    showPopup("Choose your data folder first.");
    return;
  }
  const zip = await JSZip.loadAsync(file);
  const entries = Object.keys(zip.files);
  for (const path of entries) {
    const zf = zip.files[path];
    if (zf.dir) continue;
    const parts = path.split("/").filter(Boolean);
    let dir = dataDirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const filename = parts[parts.length - 1];
    const text = await zf.async("string");
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }
  showPopup("Import complete.");
  importZipInput.value = "";
  await loadRecurring();
  if (currentDate) {
    renderActivities(buildDisplayActivities());
  }
};

// ----- Recurring UI -----
const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(timeStr) {
  if (!timeStr) return "";
  const [hour, minute] = timeStr.split(":").map(Number);
  const date = new Date();
  date.setHours(hour, minute);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatRecurringLabel(ev) {
  const parts = [];

//  if (ev.type === "weekly") {
//    const dowName = dayNames[ev.dayOfWeek ?? 0];
//    parts.push(`Weekly every ${ev.interval || 1} (${dowName})`);
//  } else if (ev.type === "daily") {
//    parts.push(`Daily every ${ev.interval || 1}`);
//  } else if (ev.type === "monthly") {
//    parts.push(`Monthly every ${ev.interval || 1} (Day ${ev.dayOfMonth})`);
//  }

//  parts.push(`• ${formatTime(ev.time)} ${ev.title}`);
    parts.push(`${ev.title}`);
  return parts.join(" ");
}

function renderRecurring() {
  recurringListEl.innerHTML = "";

  recurringEvents.forEach((ev, i) => {
    const card = document.createElement("div");
    card.className = "recurring-card";

    const left = document.createElement("div");
    left.textContent = formatRecurringLabel(ev);

    const actions = document.createElement("div");
    actions.className = "recurring-actions";

    const editBtn = document.createElement("button");
    editBtn.textContent = "✎";
    editBtn.onclick = () => openRecurringModal(ev, i);

    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.onclick = async () => {
      recurringEvents.splice(i, 1);
      await saveRecurring();
      if (currentDate) {
        renderActivities(buildDisplayActivities());
      }
    };

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    card.appendChild(left);
    card.appendChild(actions);
    recurringListEl.appendChild(card);
  });
}

function openRecurringModal(ev = null, index = null) {
  editingRecurringIndex = index;
  recTitle.value = ev?.title || "";
  recTime.value = ev?.time || "";
  recStart.value = ev?.startDate || "";
  recEnd.value = ev?.endDate || "";
  recType.value = ev?.type || "weekly";
  recInterval.value = ev?.interval || 1;
  recDow.value = ev?.dayOfWeek ?? "";
  recDom.value = ev?.dayOfMonth ?? "";
  recItems.value = (ev?.items || []).join(", ");
  recModal.classList.add("active");
}
recCancel.onclick = () => {
  recModal.classList.remove("active");
};
recSave.onclick = async () => {
  const title = recTitle.value.trim();
  if (!title) { showPopup("Title is required."); return; }

  const time = parseTimeStr(recTime.value);
  const type = recType.value;
  const interval = parseInt(recInterval.value, 10) || 1;

  // Collect multiple selections from <select multiple>
  const daysOfWeek = Array.from(recDow.selectedOptions).map(opt => parseInt(opt.value, 10));
  const daysOfMonth = Array.from(recDom.selectedOptions).map(opt => parseInt(opt.value, 10));

  // Build event object
  const ev = {
    id: editingRecurringIndex != null
      ? recurringEvents[editingRecurringIndex].id
      : `rec_${Date.now()}`,
    title,
    time,
    items: recItems.value.split(",").map(s => s.trim()).filter(Boolean),
    recurrence: {
      type,
      interval,
      daysOfWeek: daysOfWeek.length ? daysOfWeek : undefined,
      daysOfMonth: daysOfMonth.length ? daysOfMonth : undefined
    },
    startDate: recStart.value || null,
    endDate: recEnd.value || null
  };

  // Validation
  if (ev.recurrence.type === "weekly" && (!ev.recurrence.daysOfWeek || !ev.recurrence.daysOfWeek.length)) {
    showPopup("For weekly events, select at least one day of week.");
    return;
  }
  if (ev.recurrence.type === "monthly" && (!ev.recurrence.daysOfMonth || !ev.recurrence.daysOfMonth.length)) {
    showPopup("For monthly events, select at least one day of month.");
    return;
  }

  // Save or update
  if (editingRecurringIndex != null) {
    recurringEvents[editingRecurringIndex] = ev;
  } else {
    recurringEvents.push(ev);
  }

  await saveRecurring();
  recModal.classList.remove("active");

  if (currentDate) {
    renderActivities(buildDisplayActivities());
  }
};
addRecurringBtn.onclick = () => openRecurringModal();

// ----- Help overlay -----
helpBtn.onclick = () => {
  helpOverlay.classList.add("active");
};
helpClose.onclick = () => {
  helpOverlay.classList.remove("active");
};

// ----- Init (calendar first; day loads on click) -----
renderCalendar(currentYear, currentMonth);

// ----- Choose folder override (persisted) -----
chooseFolderBtn.onclick = async () => {
  try {
    dataDirHandle = await window.showDirectoryPicker();
    const perm = await dataDirHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      await saveHandle("dataDirHandle", dataDirHandle);
      await applyCustomBackground();
      await loadRecurring();
      renderCalendar(currentYear, currentMonth);
      showPopup("Data folder changed.");
    }
  } catch (err) { console.error(err); }
};



// Persist lead time
(function initReminderLead() {
  const saved = localStorage.getItem("reminderLead");
  if (saved) reminderLeadInput.value = parseInt(saved, 10);
})();
reminderLeadInput.onchange = () => {
  const v = Math.max(1, Math.min(120, parseInt(reminderLeadInput.value, 10) || 15));
  reminderLeadInput.value = v;
  localStorage.setItem("reminderLead", v);
};

// Request notification permission
notifyPermissionBtn.onclick = async () => {
  const res = await Notification.requestPermission();
  if (res === "granted") {
    showPopup("Notifications enabled.");
  } else {
    showPopup("Notifications not enabled.");
  }
};

function showPopup(message) {
  const overlay = document.getElementById("popup-overlay");
  const msgEl = document.getElementById("popup-message");
  msgEl.textContent = message;
  overlay.classList.add("active");
}

document.getElementById("popup-close").onclick = () => {
  document.getElementById("popup-overlay").classList.remove("active");
};


// ----- Trigger "Today" button automatically 2 seconds after page load -----
window.onload = function() {
  setTimeout(() => {
    const todayBtn = document.getElementById("today-btn");
    if (todayBtn) {
      todayBtn.click(); // simulate user click after 2s
    }
  }, 100); // 2000ms = 2 seconds
};

// Press Escape to close any open modal/overlay without saving
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;

  let closedSomething = false;

  // 1) Close all dynamic edit modals
  document.querySelectorAll(".edit-modal").forEach(modal => {
    modal.parentNode?.removeChild(modal);
    closedSomething = true;
  });

  // 2) Close recurring modal
  if (recModal && recModal.classList.contains("active")) {
    recModal.classList.remove("active");
    closedSomething = true;
  }

  // 3) Close settings overlay
  if (settingsOverlay && settingsOverlay.classList.contains("active")) {
    settingsOverlay.classList.remove("active");
    closedSomething = true;
  }

  // 4) Close help overlay
  if (helpOverlay && helpOverlay.classList.contains("active")) {
    helpOverlay.classList.remove("active");
    closedSomething = true;
  }

  // 5) Close popup overlay
  const popupOverlay = document.getElementById("popup-overlay");
  if (popupOverlay && popupOverlay.classList.contains("active")) {
    popupOverlay.classList.remove("active");
    closedSomething = true;
  }

  // Optional: if something was closed, prevent default and stop propagation
  if (closedSomething) {
    e.preventDefault();
    e.stopPropagation();
  }
});

function confirmDelete(message, onConfirm) {
  // Modal wrapper
  const modal = document.createElement("div");
  modal.className = "edit-modal";

  const form = document.createElement("div");
  form.className = "edit-form";

  // Message
  const msg = document.createElement("p");
  msg.textContent = message;
  form.appendChild(msg);

  // Confirm button
  const yesBtn = document.createElement("button");
  yesBtn.textContent = "Yes";
  yesBtn.onclick = () => {
    onConfirm(); // run the delete logic
    document.body.removeChild(modal);
  };

  // Cancel button
  const noBtn = document.createElement("button");
  noBtn.textContent = "Cancel";
  noBtn.onclick = () => {
    document.body.removeChild(modal);
  };

  form.appendChild(yesBtn);
  form.appendChild(noBtn);
  modal.appendChild(form);
  document.body.appendChild(modal);
}

// Default type = daily
recType.value = "Daily";
document.getElementById("dow-label").style.display = "none";
document.getElementById("dom-label").style.display = "none";

// Toggle visibility based on type
recType.onchange = () => {
  const type = recType.value;
  if (type === "weekly") {
    document.getElementById("dow-label").style.display = "block";
    document.getElementById("dom-label").style.display = "none";
  } else if (type === "monthly") {
    document.getElementById("dow-label").style.display = "none";
    document.getElementById("dom-label").style.display = "block";
  } else {
    document.getElementById("dow-label").style.display = "none";
    document.getElementById("dom-label").style.display = "none";
  }
};

addRecurringBtn.onclick = () => {
  recTitle.value = "";
  recTime.value = "";
  recStart.value = "";
  recEnd.value = "";
  recType.value = "daily"; // force default
  recInterval.value = "1";
  recItems.value = "";
  recDow.selectedIndex = -1;
  recDom.selectedIndex = -1;
  editingRecurringIndex = null;

  // Hide day selectors
  document.getElementById("dow-label").style.display = "none";
  document.getElementById("dom-label").style.display = "none";

  recModal.classList.add("active");
};