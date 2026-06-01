import "./stage-app.js?v=9071";

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STAGE_SETTINGS_COLLECTION = "stageSettings";
const EFFECTIF_SETTINGS_DOC_ID = "effectif";

const DEFAULT_EFFECTIF_SPREADSHEET_ID = "1DRZwLrNXK_kkxpSsaPn_m7XDJ5v0_5iGq-8FoWTQRYU";
const DEFAULT_EFFECTIF_GID = "460642936";

const EFFECTIF_LINK_STORAGE_KEY = "stage_effectif_google_sheet_link";
const EFFECTIF_ID_STORAGE_KEY = "stage_effectif_spreadsheet_id";
const EFFECTIF_GID_STORAGE_KEY = "stage_effectif_gid";

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

let unsubscribeEffectifSettings = null;

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

function parseGoogleSheetLink(value) {
  const link = String(value || "").trim();
  const spreadsheetMatch = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = link.match(/[?&#]gid=([0-9]+)/);

  if (!spreadsheetMatch) return null;

  return {
    link,
    spreadsheetId: spreadsheetMatch[1],
    gid: gidMatch ? gidMatch[1] : "0",
    isDefault: false
  };
}

function getLocalSettings() {
  const spreadsheetId = localStorage.getItem(EFFECTIF_ID_STORAGE_KEY) || DEFAULT_EFFECTIF_SPREADSHEET_ID;
  const gid = localStorage.getItem(EFFECTIF_GID_STORAGE_KEY) || DEFAULT_EFFECTIF_GID;
  const link = localStorage.getItem(EFFECTIF_LINK_STORAGE_KEY) || buildEffectifEditLink(spreadsheetId, gid);

  return { link, spreadsheetId, gid };
}

function sameSettings(a, b) {
  return (
    String(a?.spreadsheetId || "") === String(b?.spreadsheetId || "") &&
    String(a?.gid || "") === String(b?.gid || "") &&
    String(a?.link || "") === String(b?.link || "")
  );
}

function saveSettingsToLocalStorage(settings) {
  localStorage.setItem(EFFECTIF_LINK_STORAGE_KEY, settings.link);
  localStorage.setItem(EFFECTIF_ID_STORAGE_KEY, settings.spreadsheetId);
  localStorage.setItem(EFFECTIF_GID_STORAGE_KEY, settings.gid);
}

async function saveSharedSettings(settings) {
  await setDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID), {
    link: settings.link,
    spreadsheetId: settings.spreadsheetId,
    gid: settings.gid,
    isDefault: Boolean(settings.isDefault),
    updatedBy: auth.currentUser?.email || "professeur inconnu",
    updatedAt: serverTimestamp()
  }, { merge: true });
}

function applySharedSettings(settings, reloadOnChange = true) {
  const localSettings = getLocalSettings();

  if (sameSettings(localSettings, settings)) return;

  saveSettingsToLocalStorage(settings);

  if (reloadOnChange) {
    window.location.reload();
  }
}

function wrapEffectifActions() {
  const originalSave = window.saveEffectifLinkFromInput;
  const originalReset = window.resetEffectifLink;

  if (typeof originalSave === "function") {
    window.saveEffectifLinkFromInput = async function(...args) {
      const input = document.getElementById("effectifLinkInput");
      const settings = parseGoogleSheetLink(input?.value);

      await originalSave.apply(this, args);

      if (!settings) return;

      try {
        await saveSharedSettings(settings);
      } catch (error) {
        console.error("Erreur partage lien effectif :", error);
        alert("Le lien a été changé sur ce navigateur, mais pas partagé aux autres comptes.");
      }
    };
  }

  if (typeof originalReset === "function") {
    window.resetEffectifLink = async function(...args) {
      const confirmOriginal = window.confirm;
      let confirmed = false;

      window.confirm = function(...confirmArgs) {
        confirmed = confirmOriginal.apply(window, confirmArgs);
        return confirmed;
      };

      try {
        await originalReset.apply(this, args);
      } finally {
        window.confirm = confirmOriginal;
      }

      if (!confirmed) return;

      try {
        await saveSharedSettings(getDefaultSettings());
      } catch (error) {
        console.error("Erreur partage reset effectif :", error);
        alert("Le lien par défaut a été remis sur ce navigateur, mais pas partagé aux autres comptes.");
      }
    };
  }
}

async function loadSharedSettingsOnce() {
  const snap = await getDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID));

  if (snap.exists()) {
    applySharedSettings(snap.data());
  }
}

function startSharedSettingsListener() {
  if (unsubscribeEffectifSettings) return;

  unsubscribeEffectifSettings = onSnapshot(
    doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID),
    (snap) => {
      if (!snap.exists()) return;
      applySharedSettings(snap.data());
    },
    (error) => {
      console.error("Erreur écoute lien effectif partagé :", error);
    }
  );
}

wrapEffectifActions();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (unsubscribeEffectifSettings) {
      unsubscribeEffectifSettings();
      unsubscribeEffectifSettings = null;
    }

    return;
  }

  try {
    await loadSharedSettingsOnce();
    startSharedSettingsListener();
  } catch (error) {
    console.error("Erreur chargement lien effectif partagé :", error);
  }
});
