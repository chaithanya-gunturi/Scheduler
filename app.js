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
const newDayFileBtn = document.getElementById("new-day-file");
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
const viewDayBtn = document.getElementById("view-day");
const viewWeekBtn = document.getElementById("view-week");
const prevWeekBtn = document.getElementById("prev-week");
const nextWeekBtn = document.getElementById("next-week");


const settingsBtn = document.getElementById("settings-btn");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const reminderLeadInput = document.getElementById("reminder-lead");
const notifyPermissionBtn = document.getElementById("notify-permission");



// ----- State -----
let dataDirHandle = null;
let currentDate = null;
let currentActivities = []; // only file contents; recurring overlay is separate
let currentFileHandle = null;

let recurringEvents = [];
let editingRecurringIndex = null;

const today = new Date();
let currentMonth = today.getMonth();
let currentYear = today.getFullYear();

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
    alert("Notifications enabled.");
  } else {
    alert("Notifications not enabled.");
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
      alert("Folder permission denied. Choose a data folder to proceed.");
    }
  } catch (err) {
    console.error("initFolder error:", err);
    alert("Unable to access local storage folder. Please choose a data folder.");
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
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    if (line.startsWith("Activity:")) {
      if (current) activities.push(current);
      const payload = line.replace("Activity:", "").trim();
      const parts = payload.split("|");
      let time = "", title = payload;
      if (parts.length > 1) {
        time = parseTimeStr(parts[0].trim());
        title = parts.slice(1).join("|").trim();
      } else {
        title = payload;
      }
      current = { title, time, items: [] };
    } else if (line.startsWith("-")) {
      if (!current) current = { title: "Untitled", time: "", items: [] };
      const done = /\[x\]/.test(line);
      const itemText = line.replace(/- \[(x| )\]\s?/, "");
      current.items.push({ text: itemText, done });
    }
  }
  if (current) activities.push(current);
  return activities;
}

function serializeActivities(activities) {
  let out = "";
  for (const a of activities) {
    const head = a.time ? `${a.time} | ${a.title}` : a.title;
    out += `Activity: ${head}\n`;
    for (const i of a.items) {
      out += `- [${i.done ? "x" : " "}] ${i.text}\n`;
    }
    out += "\n";
  }
  return out.trim() + "\n";
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
  const dow = date.getDay();
  const dom = date.getDate();

  if (ev.type === "daily") {
    const anchor = new Date(2020, 0, 1);
    const daysDiff = Math.floor((date - anchor) / (1000 * 60 * 60 * 24));
    return daysDiff % (ev.interval || 1) === 0;
  }
  if (ev.type === "weekly") {
    if (dow !== ev.dayOfWeek) return false;
    const anchor = new Date(2020, 0, 1);
    const weeksDiff = Math.floor((date - anchor) / (1000 * 60 * 60 * 24 * 7));
    return weeksDiff % (ev.interval || 1) === 0;
  }
  if (ev.type === "monthly") {
    if (dom !== ev.dayOfMonth) return false;
    const anchor = new Date(2020, 0, 1);
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

// ----- Calendar rendering -----
function renderCalendar(year, month) {
  calendarEl.innerHTML = "";

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

  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = ((firstOfMonth.getDay() + 6) % 7); // Monday=0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < startOffset; i++) {
    grid.appendChild(document.createElement("div"));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dayEl = document.createElement("div");
    dayEl.className = "calendar-day";
    dayEl.textContent = d;
    dayEl.onclick = () => openDay(new Date(year, month, d));
    grid.appendChild(dayEl);
  }

  calendarEl.appendChild(grid);

  monthLabelEl.textContent = new Date(year, month, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });
}
prevMonthBtn.onclick = () => {
  currentMonth--;
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  renderCalendar(currentYear, currentMonth);
};
nextMonthBtn.onclick = () => {
  currentMonth++;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  renderCalendar(currentYear, currentMonth);
};

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


let currentWeekStart = null;

viewDayBtn.onclick = showDayView;
viewWeekBtn.onclick = async () => {
  currentWeekStart = getWeekStart(currentDate || new Date());
  await renderWeekView(currentWeekStart);
  showWeekView();
};

prevWeekBtn.onclick = async () => {
  if (!currentWeekStart) currentWeekStart = getWeekStart(currentDate || new Date());
  currentWeekStart.setDate(currentWeekStart.getDate() - 7);
  await renderWeekView(currentWeekStart);
};
nextWeekBtn.onclick = async () => {
  if (!currentWeekStart) currentWeekStart = getWeekStart(currentDate || new Date());
  currentWeekStart.setDate(currentWeekStart.getDate() + 7);
  await renderWeekView(currentWeekStart);
};

// ----- Day view (overlay recurring only for display) -----
async function openDay(date) {
  if (!dataDirHandle) {
    alert("Choose a data folder first.");
    return;
  }

  currentDate = date;
  dayTitleEl.textContent = date.toDateString();
  dayViewEl.classList.remove("hidden");

  currentFileHandle = await getDayFileHandle(date);
  const text = await readDayFile(currentFileHandle);
  currentActivities = parseActivities(text);

  // Build display list with overlayed recurring (no persistence)
  const displayActivities = buildDisplayActivities();
  renderActivities(displayActivities);

  renderActivities(buildDisplayActivities());

  const today = new Date();
  if (today.toDateString() === date.toDateString()) {
    scheduleRemindersForDate(today);
  }

}

async function renderWeekView(startDate) {
  if (!dataDirHandle) {
    alert("Choose a data folder first.");
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
  const display = [...currentActivities];
  if (currentDate) {
    recurringEvents.forEach(ev => {
      if (matchesRecurring(ev, currentDate)) {
        display.push({
          title: ev.title,
          time: ev.time,
          items: (ev.items || []).map(t => ({ text: t, done: false }))
        });
      }
    });
  }
  return display;
}

// ----- Activities rendering -----
function renderActivities(list) {
  activitiesEl.innerHTML = "";

  const sorted = [...list].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  for (const a of sorted) {
    const node = activityTemplate.content.cloneNode(true);
    const card = node.querySelector(".activity-card");
    const titleEl = node.querySelector(".activity-title");
    const editBtn = node.querySelector(".edit-activity");
    const delBtn = node.querySelector(".delete-activity");
    const checklistEl = node.querySelector(".checklist");
    const addItemBtn = node.querySelector(".add-item");

    titleEl.textContent = `${a.time ? a.time + " • " : ""}${a.title}`;

    a.items.forEach(item => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.done;
      cb.onchange = () => { item.done = cb.checked; };
      const span = document.createElement("span");
      span.textContent = item.text;
      li.appendChild(cb);
      li.appendChild(span);
      checklistEl.appendChild(li);
    });

    editBtn.onclick = () => {
      const idx = currentActivities.findIndex(
        x => x.title === a.title && x.time === a.time && x.items.length === a.items.length
      );
      if (idx >= 0) {
        const newTitle = (prompt("Activity title:", currentActivities[idx].title) ?? currentActivities[idx].title).trim();
        const newTime = parseTimeStr(prompt("Time (HH:MM):", currentActivities[idx].time) ?? currentActivities[idx].time);
        currentActivities[idx].title = newTitle;
        currentActivities[idx].time = newTime;
        renderActivities(buildDisplayActivities());
      } else {
        alert("This is a recurring overlay. Edit it in Recurring panel.");
      }
    };

    delBtn.onclick = () => {
      const idx = currentActivities.findIndex(
        x => x.title === a.title && x.time === a.time && x.items.length === a.items.length
      );
      if (idx >= 0) {
        currentActivities.splice(idx, 1);
        renderActivities(buildDisplayActivities());
      } else {
        alert("This is a recurring overlay. Delete it in Recurring panel.");
      }
    };

    addItemBtn.onclick = () => {
      const idx = currentActivities.findIndex(
        x => x.title === a.title && x.time === a.time && x.items.length === a.items.length
      );
      if (idx >= 0) {
        const text = prompt("Checklist item:");
        if (!text) return;
        currentActivities[idx].items.push({ text: text.trim(), done: false });
        renderActivities(buildDisplayActivities());
      } else {
        alert("Add items to recurring via the Recurring panel.");
      }
    };

    activitiesEl.appendChild(card);
  }
}

// ----- Activity add/save -----
addActivityBtn.onclick = () => {
  const title = prompt("Activity title?");
  if (!title) return;
  const time = parseTimeStr(prompt("Time (HH:MM)?") ?? "");
  const itemsRaw = prompt("Checklist items (comma separated)?") ?? "";
  const items = itemsRaw.split(",").map(s => s.trim()).filter(Boolean)
    .map(t => ({ text: t, done: false }));
  currentActivities.push({ title: title.trim(), time, items });
  renderActivities(buildDisplayActivities());
};

saveDayBtn.onclick = async () => {
  if (!currentFileHandle) return;
  await writeDayFile(currentFileHandle, currentActivities); // save only real activities
  alert("Saved.");
};

// ----- Quick helpers -----
newDayFileBtn.onclick = async () => {
  if (!dataDirHandle) {
    alert("Choose a data folder first.");
    return;
  }
  await getDayFileHandle(new Date());
  alert("Today file ready.");
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
    alert("Choose your data folder first.");
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
  alert("Exported.");
};

importZipInput.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!dataDirHandle) {
    alert("Choose your data folder first.");
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
  alert("Import complete.");
  importZipInput.value = "";
  await loadRecurring();
  if (currentDate) {
    renderActivities(buildDisplayActivities());
  }
};

// ----- Recurring UI -----
function renderRecurring() {
  recurringListEl.innerHTML = "";
  recurringEvents.forEach((ev, i) => {
    const card = document.createElement("div");
    card.className = "recurring-card";

    const labelParts = [];
    labelParts.push(ev.type);
    labelParts.push(`every ${ev.interval}`);
    if (ev.type === "weekly" && ev.dayOfWeek != null) labelParts.push(`(DOW ${ev.dayOfWeek})`);
    if (ev.type === "monthly" && ev.dayOfMonth != null) labelParts.push(`(DOM ${ev.dayOfMonth})`);
    const left = document.createElement("div");
    left.textContent = `${labelParts.join(" ")} • ${ev.time || ""} ${ev.title}`;

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
  const ev = {
    title: recTitle.value.trim(),
    time: parseTimeStr(recTime.value),
    type: recType.value,
    interval: parseInt(recInterval.value, 10) || 1,
    dayOfWeek: recDow.value !== "" ? parseInt(recDow.value, 10) : null,
    dayOfMonth: recDom.value !== "" ? parseInt(recDom.value, 10) : null,
    items: recItems.value.split(",").map(s => s.trim()).filter(Boolean)
  };

  if (!ev.title) { alert("Title is required."); return; }
  if (ev.type === "weekly" && (ev.dayOfWeek == null || ev.dayOfWeek < 0 || ev.dayOfWeek > 6)) {
    alert("For weekly events, set Day of week (0=Sun..6=Sat).");
    return;
  }
  if (ev.type === "monthly" && (ev.dayOfMonth == null || ev.dayOfMonth < 1 || ev.dayOfMonth > 31)) {
    alert("For monthly events, set Day of month (1–31).");
    return;
  }

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
      alert("Data folder changed.");
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
    alert("Notifications enabled.");
  } else {
    alert("Notifications not enabled.");
  }
};
