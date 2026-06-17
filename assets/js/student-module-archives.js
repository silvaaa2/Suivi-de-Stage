import { getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STAGE_SETTINGS_COLLECTION = "stageSettings";
const STAGE_HISTORY_COLLECTION = "stageHistory";
const STUDENT_MODULES_COLLECTION = "studentModules";
const STUDENT_MODULE_ARCHIVES_COLLECTION = "studentModuleArchives";
const EFFECTIF_DOC_ID = "effectif";

const DEFAULT_EFFECTIF_SPREADSHEET_ID = "1DRZwLrNXK_kkxpSsaPn_m7XDJ5v0_5iGq-8FoWTQRYU";
const DEFAULT_EFFECTIF_GID = "460642936";

const MODULE_COLUMNS = [
  { key: "module1", label: "Module 1" },
  { key: "module2", label: "Module 2" },
  { key: "module3", label: "Module 3" },
  { key: "module4", label: "Module 4" },
  { key: "exam", label: "Examen" },
  { key: "retakeExam", label: "Rattrapage" }
];

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

let listenersInstalled = false;

function buildEffectifEditLink(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}#gid=${gid}`;
}

function getDefaultSettings() {
  return {
    link: buildEffectifEditLink(DEFAULT_EFFECTIF_SPREADSHEET_ID, DEFAULT_EFFECTIF_GID),
    spreadsheetId: DEFAULT_EFFECTIF_SPREADSHEET_ID,
    gid: DEFAULT_EFFECTIF_GID,
    isDefault: true
  };
}

function parseGoogleSheetLink(value, fallbackGid = "") {
  const link = String(value || "").trim();
  const spreadsheetMatch = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = link.match(/[?&#]gid=([0-9]+)/);

  if (!spreadsheetMatch) return null;

  const gid = String(fallbackGid || gidMatch?.[1] || "0").trim() || "0";

  return {
    link: buildEffectifEditLink(spreadsheetMatch[1], gid),
    spreadsheetId: spreadsheetMatch[1],
    gid,
    isDefault: false
  };
}

function normalizeSettings(value) {
  const fallback = getDefaultSettings();
  const spreadsheetId = value?.spreadsheetId || fallback.spreadsheetId;
  const gid = String(value?.gid || fallback.gid);

  return {
    link: value?.link || buildEffectifEditLink(spreadsheetId, gid),
    spreadsheetId,
    gid,
    isDefault: Boolean(value?.isDefault),
    updatedAt: value?.updatedAt || null,
    updatedBy: value?.updatedBy || ""
  };
}

function sameEffectifTarget(a, b) {
  return (
    String(a?.spreadsheetId || "") === String(b?.spreadsheetId || "") &&
    String(a?.gid || "") === String(b?.gid || "")
  );
}

function setStatus(message, tone = "") {
  const status = document.getElementById("adminEffectifStatus");
  if (!status) return;

  status.textContent = message || "";
  status.dataset.tone = tone;
}

function setBusy(isBusy) {
  ["adminEffectifSaveBtn", "adminEffectifResetBtn", "adminEffectifOpenBtn"].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = isBusy;
  });
}

async function isCurrentUserAdmin() {
  const email = auth.currentUser?.email || "";
  if (!email) return false;

  const snap = await getDoc(doc(db, "users", email));
  return snap.exists() && snap.data().admin === true;
}

async function loadCurrentEffectifSettings() {
  const snap = await getDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_DOC_ID));
  return normalizeSettings(snap.exists() ? snap.data() : getDefaultSettings());
}

function normalizeModuleArchiveItem(docSnap) {
  const data = docSnap.data() || {};
  const checks = data.checks && typeof data.checks === "object" ? data.checks : {};
  const dates = data.dates && typeof data.dates === "object" ? data.dates : {};

  return {
    firebaseId: docSnap.id,
    idUnique: data.idUnique || "",
    normalizedIdUnique: data.normalizedIdUnique || docSnap.id,
    studentName: data.studentName || "Nom non renseigne",
    checks: MODULE_COLUMNS.reduce((result, column) => {
      result[column.key] = checks[column.key] === true;
      return result;
    }, {}),
    dates: MODULE_COLUMNS.reduce((result, column) => {
      result[column.key] = dates[column.key] || "";
      return result;
    }, {}),
    completedAt: data.completedAt || {},
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null
  };
}

function buildArchiveSummary(items) {
  const summary = {
    totalStudents: items.length
  };

  MODULE_COLUMNS.forEach(column => {
    summary[column.key] = items.filter(item => item.checks?.[column.key] === true).length;
  });

  return summary;
}

function buildArchiveId(settings) {
  const safeSheet = String(settings.spreadsheetId || "sheet").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36);
  const safeGid = String(settings.gid || "gid").replace(/[^0-9]/g, "") || "gid";
  return `modules_${safeSheet}_${safeGid}_${Date.now()}`;
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function createLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateDisplay(date) {
  return `${padDatePart(date.getDate())}/${padDatePart(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatDateIso(date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function parseCursusDateInput(value) {
  const input = String(value || "").trim();
  let year;
  let month;
  let day;

  let match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;

    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }

  const date = createLocalDate(year, month, day);
  if (!date) return null;

  return {
    date,
    iso: formatDateIso(date),
    display: formatDateDisplay(date)
  };
}

function getDefaultCursusPeriod() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = addDays(end, -13);

  return { start, end };
}

function askArchivePeriod() {
  const defaults = getDefaultCursusPeriod();
  const startInput = window.prompt(
    "Date de debut du cursus a archiver ?\n\nFormat : JJ/MM/AAAA",
    formatDateDisplay(defaults.start)
  );

  if (startInput === null) {
    throw new Error("Archivage annule.");
  }

  const start = parseCursusDateInput(startInput);
  if (!start) {
    throw new Error("Date de debut invalide. Format attendu : JJ/MM/AAAA.");
  }

  const defaultEnd = addDays(start.date, 13);
  const endInput = window.prompt(
    "Date de fin du cursus a archiver ?\n\nFormat : JJ/MM/AAAA",
    formatDateDisplay(defaultEnd)
  );

  if (endInput === null) {
    throw new Error("Archivage annule.");
  }

  const end = parseCursusDateInput(endInput);
  if (!end) {
    throw new Error("Date de fin invalide. Format attendu : JJ/MM/AAAA.");
  }

  if (end.date.getTime() < start.date.getTime()) {
    throw new Error("La date de fin doit etre apres la date de debut.");
  }

  return {
    startDate: start.iso,
    endDate: end.iso,
    startDisplay: start.display,
    endDisplay: end.display,
    durationDays: Math.round((end.date.getTime() - start.date.getTime()) / 86400000) + 1
  };
}

async function archiveActiveModulesIfEffectifChanges(nextSettings, action) {
  const previousSettings = await loadCurrentEffectifSettings();

  if (sameEffectifTarget(previousSettings, nextSettings)) {
    return null;
  }

  const modulesSnap = await getDocs(collection(db, STUDENT_MODULES_COLLECTION));

  if (modulesSnap.empty) {
    return null;
  }

  const confirmed = window.confirm(
    `Le lien d'effectif change.\n\n` +
    `Je vais archiver la feuille Modules Eleves actuelle (${modulesSnap.size} eleve(s)), puis remettre les coches actives a zero pour le nouveau cursus.\n\n` +
    `Continuer ?`
  );

  if (!confirmed) {
    throw new Error("Changement d'effectif annule.");
  }

  const period = askArchivePeriod();

  const items = [];
  modulesSnap.forEach(docSnap => {
    items.push(normalizeModuleArchiveItem(docSnap));
  });

  const archiveId = buildArchiveId(previousSettings);
  const batch = writeBatch(db);

  batch.set(doc(db, STUDENT_MODULE_ARCHIVES_COLLECTION, archiveId), {
    title: `Archive modules du ${period.startDisplay} au ${period.endDisplay}`,
    trigger: action,
    previousEffectif: previousSettings,
    nextEffectif: normalizeSettings(nextSettings),
    cursusStartDate: period.startDate,
    cursusEndDate: period.endDate,
    cursusStartDisplay: period.startDisplay,
    cursusEndDisplay: period.endDisplay,
    startDisplay: period.startDisplay,
    endDisplay: period.endDisplay,
    durationDays: period.durationDays,
    students: items,
    summary: buildArchiveSummary(items),
    archivedBy: auth.currentUser?.email || "admin",
    archivedAt: serverTimestamp()
  });

  modulesSnap.forEach(docSnap => {
    batch.delete(docSnap.ref);
  });

  await batch.commit();

  return {
    archiveId,
    totalStudents: items.length,
    cursusStartDisplay: period.startDisplay,
    cursusEndDisplay: period.endDisplay
  };
}

async function addHistory(action, details = {}) {
  if (!auth.currentUser) return;

  await addDoc(collection(db, STAGE_HISTORY_COLLECTION), {
    action,
    details,
    actor: auth.currentUser.email || "admin",
    createdAt: serverTimestamp()
  });
}

async function addHistorySafely(action, details = {}) {
  try {
    await addHistory(action, details);
  } catch (error) {
    console.warn("Historique archive modules non enregistre :", error);
  }
}

async function saveEffectifSettingsWithModuleArchive(settings, action = "effectif_link_changed") {
  if (!(await isCurrentUserAdmin())) {
    throw new Error("Acces admin requis.");
  }

  const moduleArchive = await archiveActiveModulesIfEffectifChanges(settings, action);

  await setDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_DOC_ID), {
    link: settings.link,
    spreadsheetId: settings.spreadsheetId,
    gid: settings.gid,
    isDefault: Boolean(settings.isDefault),
    updatedBy: auth.currentUser?.email || "admin",
    updatedAt: serverTimestamp(),
    lastModuleArchiveId: moduleArchive?.archiveId || null
  }, { merge: true });

  await addHistorySafely(action, {
    spreadsheetId: settings.spreadsheetId,
    gid: settings.gid,
    link: settings.link,
    moduleArchiveId: moduleArchive?.archiveId || "",
    moduleArchiveStudents: moduleArchive?.totalStudents || 0,
    moduleArchivePeriod: moduleArchive ? `${moduleArchive.cursusStartDisplay} au ${moduleArchive.cursusEndDisplay}` : ""
  });

  if (moduleArchive) {
    await addHistorySafely("student_modules_archived", {
      archiveId: moduleArchive.archiveId,
      totalStudents: moduleArchive.totalStudents,
      cursusStartDisplay: moduleArchive.cursusStartDisplay,
      cursusEndDisplay: moduleArchive.cursusEndDisplay,
      previousGid: "",
      nextGid: settings.gid
    });
  }

  return moduleArchive;
}

async function handleSaveClick(event) {
  const button = event.target.closest("#adminEffectifSaveBtn");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const linkInput = document.getElementById("adminEffectifLinkInput");
  const gidInput = document.getElementById("adminEffectifGidInput");
  const settings = parseGoogleSheetLink(linkInput?.value, gidInput?.value);

  if (!settings) {
    setStatus("Lien Google Sheets invalide.", "error");
    return;
  }

  try {
    setBusy(true);
    setStatus("Verification archive modules...", "");

    const archive = await saveEffectifSettingsWithModuleArchive(settings, "effectif_link_changed");

    setStatus(
      archive
        ? `Lien enregistre. Modules archives (${archive.totalStudents} eleve(s), ${archive.cursusStartDisplay} au ${archive.cursusEndDisplay}).`
        : "Lien effectif enregistre.",
      "ok"
    );
  } catch (error) {
    console.error("Lien effectif non sauvegarde avec archive modules :", error);
    setStatus(error.message || "Impossible d'enregistrer.", "error");
  } finally {
    setBusy(false);
  }
}

async function handleResetClick(event) {
  const button = event.target.closest("#adminEffectifResetBtn");
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  if (!window.confirm("Remettre le lien effectif par defaut ?")) return;

  try {
    setBusy(true);
    setStatus("Verification archive modules...", "");

    const archive = await saveEffectifSettingsWithModuleArchive(getDefaultSettings(), "effectif_link_reset");

    setStatus(
      archive
        ? `Lien par defaut remis. Modules archives (${archive.totalStudents} eleve(s), ${archive.cursusStartDisplay} au ${archive.cursusEndDisplay}).`
        : "Lien par defaut remis.",
      "ok"
    );
  } catch (error) {
    console.error("Reset effectif non sauvegarde avec archive modules :", error);
    setStatus(error.message || "Impossible de reinitialiser.", "error");
  } finally {
    setBusy(false);
  }
}

function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;

  document.addEventListener("click", handleSaveClick, true);
  document.addEventListener("click", handleResetClick, true);
}

installListeners();
