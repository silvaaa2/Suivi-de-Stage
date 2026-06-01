import "./stage-app.js?v=9071";

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  addDoc,
  query,
  orderBy,
  limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STAGE_SETTINGS_COLLECTION = "stageSettings";
const STAGE_HISTORY_COLLECTION = "stageHistory";
const STAGE_COMMENTS_COLLECTION = "stageComments";
const EFFECTIF_SETTINGS_DOC_ID = "effectif";
const HISTORY_LIMIT = 30;

const DEFAULT_EFFECTIF_SPREADSHEET_ID = "1DRZwLrNXK_kkxpSsaPn_m7XDJ5v0_5iGq-8FoWTQRYU";
const DEFAULT_EFFECTIF_GID = "460642936";

const EFFECTIF_LINK_STORAGE_KEY = "stage_effectif_google_sheet_link";
const EFFECTIF_ID_STORAGE_KEY = "stage_effectif_spreadsheet_id";
const EFFECTIF_GID_STORAGE_KEY = "stage_effectif_gid";

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

let unsubscribeEffectifSettings = null;
let unsubscribeHistory = null;
let unsubscribeComments = null;
let sharedEffectifSettings = null;
let latestHistoryItems = [];
let stageCommentsByDocId = new Map();
let settingsUiReady = false;
let currentUserRole = null;
let commentGridObserver = null;
let currentCommentTarget = null;

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

function normalizeSettings(settings) {
  const fallback = getDefaultSettings();
  const spreadsheetId = settings?.spreadsheetId || fallback.spreadsheetId;
  const gid = settings?.gid || fallback.gid;

  return {
    link: settings?.link || buildEffectifEditLink(spreadsheetId, gid),
    spreadsheetId,
    gid,
    isDefault: Boolean(settings?.isDefault),
    updatedBy: settings?.updatedBy || "",
    updatedAt: settings?.updatedAt || null
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

function getDisplayedSettings() {
  return normalizeSettings(sharedEffectifSettings || getLocalSettings());
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatFirestoreDate(value) {
  if (!value) return "date inconnue";

  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) return "date inconnue";

  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getHistoryLabel(action) {
  switch (action) {
    case "effectif_link_changed":
      return "Lien effectif modifié";
    case "effectif_link_reset":
      return "Lien effectif réinitialisé";
    case "stage_id_deleted":
      return "ID stage supprimé";
    case "company_list_deleted":
      return "Liste entreprise supprimée";
    case "exam_participant_archived":
      return "Participant examen masqué";
    case "all_exam_participants_archived":
      return "Participants examens masqués";
    case "stage_week_reset":
      return "Semaine archivée";
    case "stage_comment_saved":
      return "Commentaire stage modifié";
    default:
      return "Action enregistrée";
  }
}

async function loadCurrentUserRole(user) {
  if (!user?.email) return null;

  try {
    const snap = await getDoc(doc(db, "users", user.email));
    return snap.exists() ? snap.data().role || null : null;
  } catch (error) {
    console.warn("Role utilisateur non lu pour les réglages :", error);
    return null;
  }
}

function canSeeSharedSettings() {
  return currentUserRole === "prof";
}

function canUseStageComments() {
  return currentUserRole === "prof" || currentUserRole === "stage";
}

function getHistoryDetail(item) {
  const details = item.details || {};

  switch (item.action) {
    case "effectif_link_changed":
      return `gid ${details.gid || "inconnu"}`;
    case "effectif_link_reset":
      return "Retour au lien par défaut";
    case "stage_id_deleted":
      return details.idUnique ? `ID ${details.idUnique}` : details.docId || "";
    case "company_list_deleted":
      return details.companyId ? `Entreprise ${details.companyId}` : "";
    case "exam_participant_archived":
      return details.studentName || details.docId || "";
    case "all_exam_participants_archived":
      return "Suppression globale côté examens";
    case "stage_week_reset":
      return details.period || "Archive créée puis semaine réinitialisée";
    case "stage_comment_saved":
      return [details.idUnique, details.companyName].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

async function saveSharedSettings(settings) {
  const normalized = normalizeSettings(settings);

  await setDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID), {
    link: normalized.link,
    spreadsheetId: normalized.spreadsheetId,
    gid: normalized.gid,
    isDefault: Boolean(normalized.isDefault),
    updatedBy: auth.currentUser?.email || "professeur inconnu",
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function addHistory(action, details = {}) {
  if (!auth.currentUser) return;

  await addDoc(collection(db, STAGE_HISTORY_COLLECTION), {
    action,
    details,
    actor: auth.currentUser.email || "compte inconnu",
    createdAt: serverTimestamp()
  });
}

async function addHistorySafely(action, details = {}) {
  try {
    await addHistory(action, details);
  } catch (error) {
    console.warn("Historique non enregistré :", error);
  }
}

function applySharedSettings(settings, reloadOnChange = true) {
  const normalized = normalizeSettings(settings);
  const localSettings = getLocalSettings();

  sharedEffectifSettings = normalized;
  updateSettingsUi();

  if (sameSettings(localSettings, normalized)) return;

  saveSettingsToLocalStorage(normalized);

  if (reloadOnChange) {
    window.location.reload();
  }
}

function injectSettingsStyles() {
  if (document.getElementById("stageSharedSettingsStyles")) return;

  const style = document.createElement("style");
  style.id = "stageSharedSettingsStyles";
  style.textContent = `
    .shared-settings-btn {
      margin-top: 4px;
      height: 42px;
      padding: 0 16px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.065);
      color: var(--text);
      font-family: inherit;
      font-size: 12px;
      font-weight: 1000;
      text-transform: uppercase;
      letter-spacing: .02em;
      white-space: nowrap;
      cursor: pointer;
      transition: transform .18s ease, border-color .18s ease, background .18s ease;
    }

    .shared-settings-btn:hover {
      transform: translateY(-1px);
      border-color: rgba(214,180,106,.42);
      background: rgba(214,180,106,.12);
      color: var(--gold2);
    }

    .shared-settings-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0,0,0,.66);
      backdrop-filter: blur(16px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease;
    }

    .shared-settings-modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }

    .shared-settings-modal-overlay[hidden] {
      display: none !important;
    }

    .shared-settings-modal-card {
      width: min(820px, 100%);
      max-height: min(86vh, 760px);
      overflow: auto;
      position: relative;
      padding: 30px;
      border-radius: 32px;
      border: 1px solid rgba(255,255,255,.11);
      background:
        radial-gradient(circle at 16% 0%, rgba(214,180,106,.16), transparent 34%),
        linear-gradient(145deg, rgba(255,255,255,.075), rgba(255,255,255,.030)),
        rgba(8,8,8,.96);
      box-shadow:
        0 35px 120px rgba(0,0,0,.65),
        inset 0 1px 0 rgba(255,255,255,.05);
      transform: translateY(18px) scale(.98);
      transition: transform .18s ease;
    }

    .shared-settings-modal-overlay.active .shared-settings-modal-card {
      transform: translateY(0) scale(1);
    }

    .shared-settings-close {
      position: absolute;
      top: 18px;
      right: 18px;
      width: 36px;
      height: 36px;
      border: 1px solid rgba(248,113,113,.28);
      border-radius: 999px;
      background: rgba(248,113,113,.12);
      color: var(--red);
      font-size: 22px;
      font-weight: 1000;
      line-height: 1;
      cursor: pointer;
    }

    .shared-settings-modal-card h2 {
      margin: 0;
      max-width: 620px;
      font-size: clamp(34px, 5vw, 58px);
      line-height: .9;
      letter-spacing: -.065em;
    }

    .shared-settings-grid {
      margin-top: 22px;
      display: grid;
      grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr);
      gap: 16px;
      align-items: start;
    }

    .shared-settings-panel,
    .stage-history-panel {
      border-radius: 24px;
      border: 1px solid rgba(255,255,255,.10);
      background:
        radial-gradient(circle at 14% 0%, rgba(214,180,106,.10), transparent 35%),
        rgba(0,0,0,.22);
      padding: 18px;
    }

    .shared-settings-panel h3,
    .stage-history-panel h3 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
      letter-spacing: -.035em;
    }

    .shared-current-link {
      margin-top: 14px;
      padding: 13px 14px;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.045);
    }

    .shared-current-link span,
    .shared-settings-meta span {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 1000;
      text-transform: uppercase;
    }

    .shared-current-link strong {
      display: block;
      color: var(--gold2);
      font-size: 12px;
      font-weight: 900;
      line-height: 1.4;
      word-break: break-all;
    }

    .shared-settings-meta {
      margin-top: 14px;
      display: grid;
      gap: 10px;
    }

    .shared-settings-meta strong {
      display: block;
      color: var(--text);
      font-size: 13px;
      font-weight: 950;
      word-break: break-word;
    }

    .shared-settings-actions {
      margin-top: 16px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .shared-settings-actions button {
      height: 42px;
      padding: 0 15px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 1000;
      cursor: pointer;
      transition: transform .18s ease, border-color .18s ease, background .18s ease;
    }

    .shared-open-link-btn,
    .shared-change-link-btn {
      border: 1px solid rgba(214,180,106,.30);
      background: rgba(214,180,106,.12);
      color: var(--gold2);
    }

    .shared-close-btn {
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--text);
    }

    .shared-settings-actions button:hover {
      transform: translateY(-1px);
    }

    .stage-history-list {
      margin-top: 14px;
      display: grid;
      gap: 10px;
    }

    .stage-history-item {
      padding: 13px;
      border-radius: 17px;
      border: 1px solid rgba(255,255,255,.08);
      background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.020));
    }

    .stage-history-item strong {
      display: block;
      color: var(--gold2);
      font-size: 13px;
      font-weight: 1000;
    }

    .stage-history-item span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
      line-height: 1.35;
      word-break: break-word;
    }

    .stage-history-empty {
      margin-top: 14px;
      padding: 14px;
      border-radius: 17px;
      border: 1px solid rgba(214,180,106,.18);
      background: rgba(214,180,106,.08);
      color: var(--gold2);
      font-size: 13px;
      font-weight: 900;
    }

    .stage-id-row.has-stage-comment-button {
      grid-template-columns: 1fr 28px 28px;
    }

    .stage-id-row .stage-comment-btn {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(214,180,106,.28);
      background: rgba(214,180,106,.10);
      color: var(--gold2);
      font-size: 13px;
      font-weight: 1000;
      line-height: 1;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: transform .18s ease, background .18s ease, border-color .18s ease;
    }

    .stage-id-row .stage-comment-btn:hover,
    .stage-id-row .stage-comment-btn.has-comment {
      transform: scale(1.06);
      background: rgba(214,180,106,.20);
      border-color: rgba(214,180,106,.46);
    }

    .stage-comment-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 1120;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0,0,0,.66);
      backdrop-filter: blur(16px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease;
    }

    .stage-comment-modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }

    .stage-comment-modal-overlay[hidden] {
      display: none !important;
    }

    .stage-comment-modal-card {
      width: min(620px, 100%);
      position: relative;
      padding: 30px;
      border-radius: 32px;
      border: 1px solid rgba(255,255,255,.11);
      background:
        radial-gradient(circle at 16% 0%, rgba(214,180,106,.16), transparent 34%),
        linear-gradient(145deg, rgba(255,255,255,.075), rgba(255,255,255,.030)),
        rgba(8,8,8,.96);
      box-shadow:
        0 35px 120px rgba(0,0,0,.65),
        inset 0 1px 0 rgba(255,255,255,.05);
      transform: translateY(18px) scale(.98);
      transition: transform .18s ease;
    }

    .stage-comment-modal-overlay.active .stage-comment-modal-card {
      transform: translateY(0) scale(1);
    }

    .stage-comment-close {
      position: absolute;
      top: 18px;
      right: 18px;
      width: 36px;
      height: 36px;
      border: 1px solid rgba(248,113,113,.28);
      border-radius: 999px;
      background: rgba(248,113,113,.12);
      color: var(--red);
      font-size: 22px;
      font-weight: 1000;
      line-height: 1;
      cursor: pointer;
    }

    .stage-comment-modal-card h2 {
      margin: 0;
      max-width: 500px;
      font-size: clamp(32px, 5vw, 54px);
      line-height: .9;
      letter-spacing: -.06em;
    }

    .stage-comment-context {
      margin: 14px 0 16px;
      padding: 12px 14px;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.045);
      display: grid;
      gap: 6px;
    }

    .stage-comment-context strong {
      color: var(--gold2);
      font-size: 13px;
      font-weight: 1000;
    }

    .stage-comment-context span,
    .stage-comment-meta {
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
      line-height: 1.35;
    }

    .stage-comment-modal-card label {
      display: block;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 1000;
      text-transform: uppercase;
    }

    .stage-comment-modal-card textarea {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      border-radius: 22px;
      border: 1px solid rgba(255,255,255,.11);
      background: rgba(0,0,0,.30);
      color: var(--text);
      padding: 16px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 850;
      line-height: 1.45;
      outline: none;
    }

    .stage-comment-modal-card textarea:focus {
      border-color: rgba(214,180,106,.52);
      box-shadow: 0 0 0 4px rgba(214,180,106,.12);
    }

    .stage-comment-meta {
      margin-top: 10px;
    }

    .stage-comment-actions {
      margin-top: 18px;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .stage-comment-actions button {
      height: 46px;
      padding: 0 18px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 1000;
      cursor: pointer;
      transition: transform .18s ease, border-color .18s ease, background .18s ease;
    }

    .stage-comment-cancel-btn {
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--text);
    }

    .stage-comment-save-btn {
      border: 1px solid rgba(214,180,106,.30);
      background: linear-gradient(135deg, var(--gold), var(--gold2));
      color: #111;
    }

    .stage-comment-actions button:hover {
      transform: translateY(-1px);
    }

    @media (max-width: 850px) {
      .shared-settings-btn {
        width: 100%;
      }

      .shared-settings-modal-card {
        padding: 24px;
        border-radius: 26px;
      }

      .shared-settings-grid {
        grid-template-columns: 1fr;
      }

      .shared-settings-actions {
        display: grid;
        grid-template-columns: 1fr;
      }

      .stage-id-row.has-stage-comment-button {
        grid-template-columns: 1fr 28px 28px;
      }

      .stage-comment-modal-card {
        padding: 24px;
        border-radius: 26px;
      }

      .stage-comment-actions {
        display: grid;
        grid-template-columns: 1fr;
      }
    }
  `;

  document.head.appendChild(style);
}

function ensureSettingsModal() {
  if (document.getElementById("sharedSettingsModal")) return;

  document.body.insertAdjacentHTML("beforeend", `
    <div id="sharedSettingsModal" class="shared-settings-modal-overlay" hidden>
      <div class="shared-settings-modal-card">
        <button type="button" class="shared-settings-close" onclick="window.closeSharedSettingsModal()">×</button>

        <p class="kicker">Réglages partagés</p>
        <h2>Effectif et historique</h2>

        <div class="shared-settings-grid">
          <section class="shared-settings-panel">
            <p class="kicker">Effectif</p>
            <h3>Lien partagé</h3>

            <div class="shared-current-link">
              <span>Lien actuel</span>
              <strong id="sharedEffectifLinkText"></strong>
            </div>

            <div class="shared-settings-meta">
              <div>
                <span>Dernière modification</span>
                <strong id="sharedEffectifUpdatedAt">date inconnue</strong>
              </div>

              <div>
                <span>Modifié par</span>
                <strong id="sharedEffectifUpdatedBy">inconnu</strong>
              </div>
            </div>

            <div class="shared-settings-actions">
              <button type="button" class="shared-open-link-btn" onclick="window.openSharedEffectifLink()">Ouvrir le lien</button>
              <button type="button" id="sharedChangeEffectifBtn" class="shared-change-link-btn" onclick="window.openEffectifFromSharedSettings()">Changer effectif</button>
              <button type="button" class="shared-close-btn" onclick="window.closeSharedSettingsModal()">Fermer</button>
            </div>
          </section>

          <section class="stage-history-panel">
            <p class="kicker">Historique</p>
            <h3>Dernières actions</h3>
            <div id="stageHistoryList" class="stage-history-list">
              <div class="stage-history-empty">Chargement de l'historique...</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `);
}

function ensureStageCommentModal() {
  if (document.getElementById("stageCommentModal")) return;

  document.body.insertAdjacentHTML("beforeend", `
    <div id="stageCommentModal" class="stage-comment-modal-overlay" hidden>
      <div class="stage-comment-modal-card">
        <button type="button" class="stage-comment-close" onclick="window.closeStageCommentModal()">×</button>

        <p class="kicker">Commentaire entreprise</p>
        <h2>Note sur l'ID</h2>

        <div class="stage-comment-context">
          <strong id="stageCommentIdText">ID inconnu</strong>
          <span id="stageCommentCompanyText">Entreprise inconnue</span>
        </div>

        <label for="stageCommentTextarea">Commentaire</label>
        <textarea id="stageCommentTextarea" placeholder="Ajoutez une information utile pour le suivi..."></textarea>

        <p id="stageCommentMeta" class="stage-comment-meta"></p>

        <div class="stage-comment-actions">
          <button type="button" class="stage-comment-cancel-btn" onclick="window.closeStageCommentModal()">Annuler</button>
          <button type="button" id="stageCommentSaveBtn" class="stage-comment-save-btn" onclick="window.saveStageComment()">Enregistrer</button>
        </div>
      </div>
    </div>
  `);
}

function ensureSettingsButton() {
  if (document.getElementById("sharedSettingsBtn")) return;
  if (!canSeeSharedSettings()) return;

  const cardHead = document.querySelector(".stage-exams-card .card-head-with-action");
  if (!cardHead) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "sharedSettingsBtn";
  button.className = "shared-settings-btn";
  button.textContent = "Réglages";
  button.addEventListener("click", window.openSharedSettingsModal);

  const changeEffectifBtn = document.getElementById("changeEffectifBtn");

  if (changeEffectifBtn) {
    changeEffectifBtn.insertAdjacentElement("afterend", button);
  } else {
    cardHead.appendChild(button);
  }
}

function ensureSettingsUi() {
  if (!canSeeSharedSettings()) {
    removeSettingsUi();
    return;
  }

  injectSettingsStyles();
  ensureSettingsModal();
  ensureSettingsButton();
  updateSettingsUi();
  settingsUiReady = true;
}

function removeSettingsUi() {
  const button = document.getElementById("sharedSettingsBtn");
  const modal = document.getElementById("sharedSettingsModal");

  if (button) button.remove();
  if (modal) modal.remove();

  settingsUiReady = false;
}

function updateSettingsUi() {
  const settings = getDisplayedSettings();
  const linkText = document.getElementById("sharedEffectifLinkText");
  const updatedAt = document.getElementById("sharedEffectifUpdatedAt");
  const updatedBy = document.getElementById("sharedEffectifUpdatedBy");
  const changeButton = document.getElementById("sharedChangeEffectifBtn");

  if (linkText) linkText.textContent = settings.link;
  if (updatedAt) updatedAt.textContent = formatFirestoreDate(settings.updatedAt);
  if (updatedBy) updatedBy.textContent = settings.updatedBy || "pas encore enregistré";

  if (changeButton) {
    const originalChangeButton = document.getElementById("changeEffectifBtn");
    changeButton.hidden = Boolean(originalChangeButton?.hidden);
  }

  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById("stageHistoryList");
  if (!list) return;

  if (!latestHistoryItems.length) {
    list.innerHTML = `
      <div class="stage-history-empty">
        Aucun historique pour le moment. Les prochaines actions seront listées ici.
      </div>
    `;
    return;
  }

  list.innerHTML = latestHistoryItems.map(item => {
    const detail = getHistoryDetail(item);
    const meta = [
      detail,
      item.actor || "compte inconnu",
      formatFirestoreDate(item.createdAt)
    ].filter(Boolean).join(" · ");

    return `
      <div class="stage-history-item">
        <strong>${escapeHtml(getHistoryLabel(item.action))}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
    `;
  }).join("");
}

function openModal(modal) {
  if (!modal) return;

  modal.hidden = false;

  requestAnimationFrame(() => {
    modal.classList.add("active");
  });
}

function closeModal(modal) {
  if (!modal) return;

  modal.classList.remove("active");

  setTimeout(() => {
    modal.hidden = true;
  }, 180);
}

window.openSharedSettingsModal = function() {
  if (!canSeeSharedSettings()) {
    alert("Seul un compte professeur peut voir les réglages.");
    return;
  }

  ensureSettingsUi();
  openModal(document.getElementById("sharedSettingsModal"));
};

window.closeSharedSettingsModal = function() {
  closeModal(document.getElementById("sharedSettingsModal"));
};

window.openSharedEffectifLink = function() {
  const settings = getDisplayedSettings();
  window.open(settings.link, "_blank", "noopener,noreferrer");
};

window.openEffectifFromSharedSettings = function() {
  window.closeSharedSettingsModal();

  if (typeof window.openEffectifLinkModal === "function") {
    window.openEffectifLinkModal();
  }
};

function getStageRowInfo(row) {
  const docId = row?.dataset?.stageRowId || "";
  const idUnique = row?.querySelector("strong")?.textContent?.trim() || "";
  const companyName = row?.closest(".company-column")?.querySelector(".company-head")?.textContent?.trim() || "";
  const companyId = docId.includes("__") ? docId.split("__")[0] : "";

  return { docId, idUnique, companyId, companyName };
}

function decorateStageCommentButtons() {
  if (!canUseStageComments()) return;

  injectSettingsStyles();
  ensureStageCommentModal();

  document.querySelectorAll(".stage-id-row[data-stage-row-id]").forEach(row => {
    const info = getStageRowInfo(row);
    if (!info.docId) return;

    row.classList.add("has-stage-comment-button");

    let button = row.querySelector(".stage-comment-btn");

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "stage-comment-btn";
      button.textContent = "💬";

      const deleteButton = row.querySelector("button");
      if (deleteButton) {
        row.insertBefore(button, deleteButton);
      } else {
        row.appendChild(button);
      }
    }

    const comment = stageCommentsByDocId.get(info.docId);
    const hasComment = Boolean(String(comment?.comment || "").trim());

    button.classList.toggle("has-comment", hasComment);
    button.title = hasComment ? "Lire ou modifier le commentaire" : "Ajouter un commentaire";
    button.onclick = () => window.openStageCommentModal(info.docId, info.idUnique, info.companyId, info.companyName);
  });
}

function startStageRowsObserver() {
  const companyGrid = document.getElementById("companyGrid");
  if (!companyGrid || commentGridObserver) return;

  let scheduled = false;

  commentGridObserver = new MutationObserver(() => {
    if (scheduled) return;

    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;
      decorateStageCommentButtons();
    });
  });

  commentGridObserver.observe(companyGrid, {
    childList: true,
    subtree: true
  });

  decorateStageCommentButtons();
}

function stopStageRowsObserver() {
  if (!commentGridObserver) return;

  commentGridObserver.disconnect();
  commentGridObserver = null;
}

window.openStageCommentModal = function(docId, idUnique, companyId, companyName) {
  if (!canUseStageComments()) {
    alert("Ce compte ne peut pas utiliser les commentaires.");
    return;
  }

  ensureStageCommentModal();

  currentCommentTarget = {
    docId: String(docId || ""),
    idUnique: String(idUnique || ""),
    companyId: String(companyId || ""),
    companyName: String(companyName || "")
  };

  const comment = stageCommentsByDocId.get(currentCommentTarget.docId);
  const textarea = document.getElementById("stageCommentTextarea");
  const idText = document.getElementById("stageCommentIdText");
  const companyText = document.getElementById("stageCommentCompanyText");
  const meta = document.getElementById("stageCommentMeta");

  if (textarea) textarea.value = comment?.comment || "";
  if (idText) idText.textContent = `ID ${currentCommentTarget.idUnique || "inconnu"}`;
  if (companyText) companyText.textContent = currentCommentTarget.companyName || "Entreprise inconnue";

  if (meta) {
    const updatedBy = comment?.updatedBy || "pas encore modifié";
    const updatedAt = comment?.updatedAt ? formatFirestoreDate(comment.updatedAt) : "";
    meta.textContent = updatedAt ? `Dernière modification : ${updatedAt} par ${updatedBy}` : "Aucun commentaire enregistré.";
  }

  openModal(document.getElementById("stageCommentModal"));

  requestAnimationFrame(() => {
    textarea?.focus();
  });
};

window.closeStageCommentModal = function() {
  closeModal(document.getElementById("stageCommentModal"));
};

window.saveStageComment = async function() {
  if (!currentCommentTarget?.docId) {
    alert("ID introuvable pour ce commentaire.");
    return;
  }

  const textarea = document.getElementById("stageCommentTextarea");
  const saveButton = document.getElementById("stageCommentSaveBtn");
  const comment = String(textarea?.value || "").trim();

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Enregistrement...";
  }

  try {
    const existing = stageCommentsByDocId.get(currentCommentTarget.docId);
    const payload = {
      idUnique: currentCommentTarget.idUnique,
      companyId: currentCommentTarget.companyId,
      companyName: currentCommentTarget.companyName,
      comment,
      updatedBy: auth.currentUser?.email || "compte inconnu",
      updatedAt: serverTimestamp()
    };

    if (!existing?.createdAt) {
      payload.createdAt = serverTimestamp();
    }

    await setDoc(doc(db, STAGE_COMMENTS_COLLECTION, currentCommentTarget.docId), payload, { merge: true });
    await addHistorySafely("stage_comment_saved", {
      idUnique: currentCommentTarget.idUnique,
      companyName: currentCommentTarget.companyName
    });

    window.closeStageCommentModal();
  } catch (error) {
    console.error("Erreur commentaire stage :", error);
    alert("Impossible d'enregistrer le commentaire. Vérifie les règles Firebase.");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Enregistrer";
    }
  }
};

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
        await addHistorySafely("effectif_link_changed", {
          spreadsheetId: settings.spreadsheetId,
          gid: settings.gid,
          link: settings.link
        });
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
        const settings = getDefaultSettings();
        await saveSharedSettings(settings);
        await addHistorySafely("effectif_link_reset", {
          spreadsheetId: settings.spreadsheetId,
          gid: settings.gid,
          link: settings.link
        });
      } catch (error) {
        console.error("Erreur partage reset effectif :", error);
        alert("Le lien par défaut a été remis sur ce navigateur, mais pas partagé aux autres comptes.");
      }
    };
  }
}

function wrapStageActionsForHistory() {
  if (window.__stageHistoryActionsWrapped) return;
  window.__stageHistoryActionsWrapped = true;

  const originalDeleteStageId = window.deleteStageIdFromStage;
  if (typeof originalDeleteStageId === "function") {
    window.deleteStageIdFromStage = async function(docId, idUnique, ...args) {
      const result = await originalDeleteStageId.apply(this, [docId, idUnique, ...args]);
      await addHistorySafely("stage_id_deleted", { docId: docId || "", idUnique: idUnique || "" });
      return result;
    };
  }

  const originalDeleteCompanyList = window.deleteCompanyStageList;
  if (typeof originalDeleteCompanyList === "function") {
    window.deleteCompanyStageList = async function(companyId, ...args) {
      const confirmOriginal = window.confirm;
      let confirmed = false;

      window.confirm = function(...confirmArgs) {
        confirmed = confirmOriginal.apply(window, confirmArgs);
        return confirmed;
      };

      try {
        const result = await originalDeleteCompanyList.apply(this, [companyId, ...args]);

        if (confirmed) {
          await addHistorySafely("company_list_deleted", { companyId: companyId || "" });
        }

        return result;
      } finally {
        window.confirm = confirmOriginal;
      }
    };
  }

  const originalDeleteExamParticipant = window.deleteExamParticipantFromStage;
  if (typeof originalDeleteExamParticipant === "function") {
    window.deleteExamParticipantFromStage = async function(docId, studentName, ...args) {
      const result = await originalDeleteExamParticipant.apply(this, [docId, studentName, ...args]);
      await addHistorySafely("exam_participant_archived", {
        docId: docId || "",
        studentName: studentName || ""
      });
      return result;
    };
  }

  const originalDeleteAllExamParticipants = window.deleteAllExamParticipantsFromStage;
  if (typeof originalDeleteAllExamParticipants === "function") {
    window.deleteAllExamParticipantsFromStage = async function(...args) {
      const promptOriginal = window.prompt;
      let typed = "";

      window.prompt = function(...promptArgs) {
        typed = promptOriginal.apply(window, promptArgs);
        return typed;
      };

      try {
        const result = await originalDeleteAllExamParticipants.apply(this, args);

        if (typed === "RESET") {
          await addHistorySafely("all_exam_participants_archived");
        }

        return result;
      } finally {
        window.prompt = promptOriginal;
      }
    };
  }

  const originalResetStageWeek = window.resetStageWeek;
  if (typeof originalResetStageWeek === "function") {
    window.resetStageWeek = async function(...args) {
      const promptOriginal = window.prompt;
      const answers = [];

      window.prompt = function(...promptArgs) {
        const answer = promptOriginal.apply(window, promptArgs);
        answers.push(answer);
        return answer;
      };

      try {
        const result = await originalResetStageWeek.apply(this, args);
        const confirmed = answers.includes("ARCHIVE");

        if (confirmed) {
          await addHistorySafely("stage_week_reset", {
            period: `${answers[0] || "?"} - ${answers[1] || "?"}`
          });
        }

        return result;
      } finally {
        window.prompt = promptOriginal;
      }
    };
  }
}

async function loadSharedSettingsOnce() {
  const snap = await getDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_SETTINGS_DOC_ID));

  if (snap.exists()) {
    applySharedSettings(snap.data());
    return;
  }

  sharedEffectifSettings = normalizeSettings(getLocalSettings());
  updateSettingsUi();
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

function startHistoryListener() {
  if (unsubscribeHistory) return;
  if (!canSeeSharedSettings()) return;

  const historyQuery = query(
    collection(db, STAGE_HISTORY_COLLECTION),
    orderBy("createdAt", "desc"),
    limit(HISTORY_LIMIT)
  );

  unsubscribeHistory = onSnapshot(
    historyQuery,
    (snap) => {
      latestHistoryItems = [];

      snap.forEach(docSnap => {
        latestHistoryItems.push({
          firebaseId: docSnap.id,
          ...docSnap.data()
        });
      });

      renderHistoryList();
    },
    (error) => {
      console.error("Erreur écoute historique stage :", error);

      const list = document.getElementById("stageHistoryList");
      if (list) {
        list.innerHTML = `
          <div class="stage-history-empty">
            Historique indisponible. Vérifie les règles Firebase.
          </div>
        `;
      }
    }
  );
}

function startStageCommentsListener() {
  if (!canUseStageComments()) return;

  injectSettingsStyles();
  ensureStageCommentModal();
  startStageRowsObserver();

  if (unsubscribeComments) return;

  unsubscribeComments = onSnapshot(
    collection(db, STAGE_COMMENTS_COLLECTION),
    (snap) => {
      stageCommentsByDocId = new Map();

      snap.forEach(docSnap => {
        stageCommentsByDocId.set(docSnap.id, {
          firebaseId: docSnap.id,
          ...docSnap.data()
        });
      });

      decorateStageCommentButtons();
    },
    (error) => {
      console.error("Erreur écoute commentaires stage :", error);
    }
  );
}

function stopRealtimeListeners() {
  if (unsubscribeEffectifSettings) {
    unsubscribeEffectifSettings();
    unsubscribeEffectifSettings = null;
  }

  if (unsubscribeHistory) {
    unsubscribeHistory();
    unsubscribeHistory = null;
  }

  if (unsubscribeComments) {
    unsubscribeComments();
    unsubscribeComments = null;
  }

  stageCommentsByDocId = new Map();
  stopStageRowsObserver();
}

wrapEffectifActions();
wrapStageActionsForHistory();

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  window.closeSharedSettingsModal();
  window.closeStageCommentModal();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUserRole = null;
    stopRealtimeListeners();
    removeSettingsUi();
    return;
  }

  currentUserRole = await loadCurrentUserRole(user);

  if (canSeeSharedSettings()) {
    ensureSettingsUi();
    setTimeout(ensureSettingsUi, 250);
    setTimeout(ensureSettingsUi, 1000);
  } else {
    removeSettingsUi();
  }

  try {
    await loadSharedSettingsOnce();
    startSharedSettingsListener();
    startStageCommentsListener();

    if (canSeeSharedSettings()) {
      startHistoryListener();
    }
  } catch (error) {
    console.error("Erreur chargement réglages partagés :", error);
  }

  if (!settingsUiReady) {
    ensureSettingsUi();
  }

  if (canUseStageComments()) {
    decorateStageCommentButtons();
    setTimeout(decorateStageCommentButtons, 250);
    setTimeout(decorateStageCommentButtons, 1000);
  }
});
