import { getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STAGE_SETTINGS_COLLECTION = "stageSettings";
const EFFECTIF_SETTINGS_DOC_ID = "effectif";

const DEFAULT_EFFECTIF_SPREADSHEET_ID = "1DRZwLrNXK_kkxpSsaPn_m7XDJ5v0_5iGq-8FoWTQRYU";
const DEFAULT_EFFECTIF_GID = "460642936";

const EFFECTIF_LINK_STORAGE_KEY = "stage_effectif_google_sheet_link";
const EFFECTIF_ID_STORAGE_KEY = "stage_effectif_spreadsheet_id";
const EFFECTIF_GID_STORAGE_KEY = "stage_effectif_gid";

const app = getApp();
const db = getFirestore(app);

let effectifIdSet = null;
let loadingEffectifIds = null;
let decorateQueued = false;

function normalizeIdUnique(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function buildEffectifEditLink(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}#gid=${gid}`;
}

function getLocalSettings() {
  const spreadsheetId = localStorage.getItem(EFFECTIF_ID_STORAGE_KEY) || DEFAULT_EFFECTIF_SPREADSHEET_ID;
  const gid = localStorage.getItem(EFFECTIF_GID_STORAGE_KEY) || DEFAULT_EFFECTIF_GID;
  const link = localStorage.getItem(EFFECTIF_LINK_STORAGE_KEY) || buildEffectifEditLink(spreadsheetId, gid);

  return { link, spreadsheetId, gid };
}

function normalizeSettings(settings) {
  const fallback = getLocalSettings();
  const spreadsheetId = settings?.spreadsheetId || fallback.spreadsheetId;
  const gid = settings?.gid || fallback.gid;

  return {
    link: settings?.link || fallback.link,
    spreadsheetId,
    gid
  };
}

async function loadEffectifSettings() {
  try {
    const snap = await getDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID));
    return normalizeSettings(snap.exists() ? snap.data() : null);
  } catch (error) {
    console.warn("Reglage effectif indisponible, fallback local utilise :", error);
    return normalizeSettings(null);
  }
}

function buildEffectifCsvUrl(settings) {
  return `https://docs.google.com/spreadsheets/d/${settings.spreadsheetId}/export?format=csv&gid=${settings.gid}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      value += '"';
      i++;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      row.push(value);

      if (row.some(cell => String(cell).trim() !== "")) {
        rows.push(row);
      }

      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  row.push(value);

  if (row.some(cell => String(cell).trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function extractEffectifIds(rows) {
  if (!rows.length) return new Set();

  const firstCell = normalizeIdUnique(rows[0]?.[0] || "");
  const hasHeader = firstCell.includes("id") || firstCell.includes("unique");
  const dataRows = hasHeader ? rows.slice(1) : rows;

  return new Set(
    dataRows
      .map(row => normalizeIdUnique(row[0] || ""))
      .filter(Boolean)
  );
}

async function loadEffectifIds() {
  if (effectifIdSet) return effectifIdSet;
  if (loadingEffectifIds) return loadingEffectifIds;

  loadingEffectifIds = (async () => {
    const settings = await loadEffectifSettings();
    const response = await fetch(buildEffectifCsvUrl(settings));

    if (!response.ok) {
      throw new Error(`Erreur Google Sheets : ${response.status}`);
    }

    const csvText = await response.text();
    effectifIdSet = extractEffectifIds(parseCsv(csvText));
    return effectifIdSet;
  })().finally(() => {
    loadingEffectifIds = null;
  });

  return loadingEffectifIds;
}

function injectStyles() {
  if (document.getElementById("stageEffectifMembershipStyles")) return;

  const style = document.createElement("style");
  style.id = "stageEffectifMembershipStyles";
  style.textContent = `
    .stage-id-row.effectif-missing {
      border-color: rgba(251,146,60,.48) !important;
      background:
        radial-gradient(circle at 20% 10%, rgba(255,255,255,.14), transparent 30%),
        linear-gradient(135deg, rgba(251,146,60,.24), rgba(251,191,36,.10)) !important;
      box-shadow: 0 0 0 1px rgba(251,146,60,.08), 0 0 18px rgba(251,146,60,.16) !important;
    }

    .stage-id-row.effectif-missing strong {
      color: #fdba74 !important;
    }

    .stage-id-row.effectif-missing .stage-comment-btn {
      border-color: rgba(251,146,60,.36);
      background: rgba(251,146,60,.13);
    }
  `;

  document.head.appendChild(style);
}

function decorateRows(effectifIds) {
  document.querySelectorAll(".stage-id-row[data-stage-row-id]").forEach(row => {
    const idUnique = normalizeIdUnique(row.querySelector("strong")?.textContent || "");
    const isMissing = Boolean(idUnique && !effectifIds.has(idUnique));

    row.classList.toggle("effectif-missing", isMissing);
    row.title = isMissing
      ? "ID absent de la liste effectif"
      : "ID present dans la liste effectif";
  });
}

function queueDecorateRows() {
  if (decorateQueued) return;
  decorateQueued = true;

  requestAnimationFrame(async () => {
    decorateQueued = false;

    try {
      const effectifIds = await loadEffectifIds();
      decorateRows(effectifIds);
    } catch (error) {
      console.error("Impossible de verifier les IDs dans l'effectif :", error);
    }
  });
}

function startObserver() {
  const companyGrid = document.getElementById("companyGrid");
  if (!companyGrid) {
    window.setTimeout(startObserver, 300);
    return;
  }

  const observer = new MutationObserver(queueDecorateRows);
  observer.observe(companyGrid, {
    childList: true,
    subtree: true
  });

  queueDecorateRows();
}

injectStyles();
startObserver();

window.refreshEffectifMembershipColors = function() {
  effectifIdSet = null;
  queueDecorateRows();
};
