import { getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const STAGE_SETTINGS_COLLECTION = "stageSettings";
const STAGE_HISTORY_COLLECTION = "stageHistory";
const EFFECTIF_DOC_ID = "effectif";

const DEFAULT_EFFECTIF_SPREADSHEET_ID = "1DRZwLrNXK_kkxpSsaPn_m7XDJ5v0_5iGq-8FoWTQRYU";
const DEFAULT_EFFECTIF_GID = "460642936";

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

let currentUserIsAdmin = false;
let currentSettings = null;
let unsubscribeEffectif = null;
let wrappersInstalled = false;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function injectStyles() {
  if (document.getElementById("adminEffectifSettingsStyles")) return;

  const style = document.createElement("style");
  style.id = "adminEffectifSettingsStyles";
  style.textContent = `
    .admin-effectif-card {
      margin-top: 16px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid rgba(214,180,106,.16);
      background:
        radial-gradient(circle at 12% 0%, rgba(214,180,106,.12), transparent 34%),
        rgba(255,255,255,.035);
    }

    .admin-effectif-card h3 {
      margin: 0;
      color: var(--text);
      font-size: 24px;
      line-height: 1;
      letter-spacing: -.035em;
    }

    .admin-effectif-note {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 850;
      line-height: 1.45;
    }

    .admin-effectif-grid {
      margin-top: 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px;
      gap: 10px;
      align-items: end;
    }

    .admin-effectif-field {
      display: grid;
      gap: 7px;
    }

    .admin-effectif-field label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 1000;
      text-transform: uppercase;
    }

    .admin-effectif-field textarea,
    .admin-effectif-field input {
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(0,0,0,.28);
      color: var(--text);
      padding: 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 850;
      outline: none;
    }

    .admin-effectif-field textarea {
      min-height: 74px;
      resize: vertical;
      line-height: 1.4;
    }

    .admin-effectif-field textarea:focus,
    .admin-effectif-field input:focus {
      border-color: rgba(214,180,106,.48);
      box-shadow: 0 0 0 4px rgba(214,180,106,.10);
    }

    .admin-effectif-actions {
      margin-top: 12px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }

    .admin-effectif-actions button {
      height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 1000;
      cursor: pointer;
    }

    .admin-effectif-save,
    .admin-effectif-open {
      border: 1px solid rgba(214,180,106,.30);
      background: rgba(214,180,106,.12);
      color: var(--gold2);
    }

    .admin-effectif-reset {
      border: 1px solid rgba(248,113,113,.28);
      background: rgba(248,113,113,.10);
      color: #fecaca;
    }

    .admin-effectif-status {
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
    }

    .admin-effectif-status[data-tone="ok"] {
      color: #86efac;
    }

    .admin-effectif-status[data-tone="error"] {
      color: #fca5a5;
    }

    @media (max-width: 850px) {
      .admin-effectif-grid {
        grid-template-columns: 1fr;
      }

      .admin-effectif-actions {
        display: grid;
        grid-template-columns: 1fr;
      }
    }
  `;

  document.head.appendChild(style);
}

async function loadCurrentUserAccess(user) {
  if (!user?.email) return false;

  try {
    const snap = await getDoc(doc(db, "users", user.email));
    return snap.exists() && snap.data().admin === true;
  } catch (error) {
    console.warn("Acces admin effectif non lu :", error);
    return false;
  }
}

function setStatus(message, tone = "") {
  const status = document.getElementById("adminEffectifStatus");
  if (!status) return;

  status.textContent = message || "";
  status.dataset.tone = tone;
}

function setAdminEffectifButtonVisibility() {
  const button = document.getElementById("changeEffectifBtn");
  if (!button) return;

  button.hidden = !currentUserIsAdmin;
  button.style.display = currentUserIsAdmin ? "" : "none";
}

function hydrateEditor() {
  const settings = normalizeSettings(currentSettings || getDefaultSettings());
  const linkInput = document.getElementById("adminEffectifLinkInput");
  const gidInput = document.getElementById("adminEffectifGidInput");
  const meta = document.getElementById("adminEffectifMeta");

  if (linkInput) linkInput.value = settings.link;
  if (gidInput) gidInput.value = settings.gid;

  if (meta) {
    const updatedBy = settings.updatedBy || "pas encore enregistre";
    meta.textContent = `Derniere modification : ${formatFirestoreDate(settings.updatedAt)} par ${updatedBy}`;
  }
}

function ensureAdminEffectifPanel() {
  if (!currentUserIsAdmin) return;

  const modalCard = document.querySelector("#adminModal .admin-modal-card");
  const usersList = document.getElementById("adminUsersList");

  if (!modalCard || !usersList || document.getElementById("adminEffectifSettings")) return;

  injectStyles();

  usersList.insertAdjacentHTML("beforebegin", `
    <section class="admin-effectif-card" id="adminEffectifSettings">
      <p class="kicker">Effectif partagé</p>
      <h3>Lien Google Sheets</h3>
      <p class="admin-effectif-note">
        Ce réglage est lu par les comptes stage/entreprise. Seul un admin peut modifier le lien et le GID.
      </p>

      <div class="admin-effectif-grid">
        <div class="admin-effectif-field">
          <label for="adminEffectifLinkInput">Lien Google Sheets</label>
          <textarea id="adminEffectifLinkInput" placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=..."></textarea>
        </div>

        <div class="admin-effectif-field">
          <label for="adminEffectifGidInput">GID</label>
          <input id="adminEffectifGidInput" type="text" inputmode="numeric" autocomplete="off" placeholder="${escapeHtml(DEFAULT_EFFECTIF_GID)}">
        </div>
      </div>

      <p class="admin-effectif-note" id="adminEffectifMeta"></p>

      <div class="admin-effectif-actions">
        <button type="button" class="admin-effectif-save" id="adminEffectifSaveBtn">Enregistrer</button>
        <button type="button" class="admin-effectif-open" id="adminEffectifOpenBtn">Ouvrir le lien</button>
        <button type="button" class="admin-effectif-reset" id="adminEffectifResetBtn">Réinitialiser</button>
        <span class="admin-effectif-status" id="adminEffectifStatus"></span>
      </div>
    </section>
  `);

  document.getElementById("adminEffectifSaveBtn")?.addEventListener("click", saveAdminEffectifSettings);
  document.getElementById("adminEffectifOpenBtn")?.addEventListener("click", openAdminEffectifLink);
  document.getElementById("adminEffectifResetBtn")?.addEventListener("click", resetAdminEffectifSettings);

  document.getElementById("adminEffectifLinkInput")?.addEventListener("input", event => {
    const gidInput = document.getElementById("adminEffectifGidInput");
    const parsed = parseGoogleSheetLink(event.target.value, "");

    if (gidInput && parsed?.gid && parsed.gid !== "0") {
      gidInput.value = parsed.gid;
    }
  });

  hydrateEditor();
}

function installEffectifGuards() {
  if (wrappersInstalled) return;
  if (
    typeof window.openEffectifLinkModal !== "function" ||
    typeof window.saveEffectifLinkFromInput !== "function" ||
    typeof window.resetEffectifLink !== "function"
  ) {
    window.setTimeout(installEffectifGuards, 200);
    return;
  }

  wrappersInstalled = true;

  const originalOpen = window.openEffectifLinkModal;
  const originalSave = window.saveEffectifLinkFromInput;
  const originalReset = window.resetEffectifLink;

  window.openEffectifLinkModal = function(...args) {
    if (!currentUserIsAdmin) {
      alert("Seul un compte admin peut changer le lien d'effectif.");
      return;
    }

    return originalOpen.apply(this, args);
  };

  window.saveEffectifLinkFromInput = function(...args) {
    if (!currentUserIsAdmin) {
      alert("Seul un compte admin peut enregistrer le lien d'effectif.");
      return;
    }

    return originalSave.apply(this, args);
  };

  window.resetEffectifLink = function(...args) {
    if (!currentUserIsAdmin) {
      alert("Seul un compte admin peut réinitialiser le lien d'effectif.");
      return;
    }

    return originalReset.apply(this, args);
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
    console.warn("Historique effectif non enregistre :", error);
  }
}

async function saveSettings(settings, action = "effectif_link_changed") {
  if (!currentUserIsAdmin) {
    alert("Acces admin requis.");
    return;
  }

  await setDoc(doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_DOC_ID), {
    link: settings.link,
    spreadsheetId: settings.spreadsheetId,
    gid: settings.gid,
    isDefault: Boolean(settings.isDefault),
    updatedBy: auth.currentUser?.email || "admin",
    updatedAt: serverTimestamp()
  }, { merge: true });

  await addHistorySafely(action, {
    spreadsheetId: settings.spreadsheetId,
    gid: settings.gid,
    link: settings.link
  });
}

async function saveAdminEffectifSettings() {
  const linkInput = document.getElementById("adminEffectifLinkInput");
  const gidInput = document.getElementById("adminEffectifGidInput");
  const parsed = parseGoogleSheetLink(linkInput?.value, gidInput?.value);

  if (!parsed) {
    setStatus("Lien Google Sheets invalide.", "error");
    return;
  }

  try {
    setStatus("Enregistrement...", "");
    await saveSettings(parsed);
    setStatus("Lien effectif enregistré.", "ok");
  } catch (error) {
    console.error("Lien effectif non sauvegarde :", error);
    setStatus("Impossible d'enregistrer. Verifie les regles Firebase.", "error");
  }
}

function openAdminEffectifLink() {
  const settings = normalizeSettings(currentSettings || getDefaultSettings());
  window.open(settings.link, "_blank", "noopener,noreferrer");
}

async function resetAdminEffectifSettings() {
  if (!confirm("Remettre le lien effectif par defaut ?")) return;

  try {
    setStatus("Reinitialisation...", "");
    await saveSettings(getDefaultSettings(), "effectif_link_reset");
    setStatus("Lien par defaut remis.", "ok");
  } catch (error) {
    console.error("Reset effectif non sauvegarde :", error);
    setStatus("Impossible de reinitialiser. Verifie les regles Firebase.", "error");
  }
}

function startSettingsListener() {
  if (unsubscribeEffectif) return;

  unsubscribeEffectif = onSnapshot(
    doc(db, STAGE_SETTINGS_COLLECTION, EFFECTIF_DOC_ID),
    (snap) => {
      currentSettings = snap.exists() ? snap.data() : getDefaultSettings();
      hydrateEditor();
    },
    (error) => {
      console.error("Erreur lecture effectif admin :", error);
      setStatus("Lecture du reglage effectif impossible.", "error");
    }
  );
}

function stopSettingsListener() {
  if (!unsubscribeEffectif) return;
  unsubscribeEffectif();
  unsubscribeEffectif = null;
}

function startDomObserver() {
  const observer = new MutationObserver(() => {
    setAdminEffectifButtonVisibility();
    ensureAdminEffectifPanel();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

onAuthStateChanged(auth, async user => {
  currentUserIsAdmin = await loadCurrentUserAccess(user);

  setAdminEffectifButtonVisibility();
  installEffectifGuards();

  if (!currentUserIsAdmin) {
    stopSettingsListener();
    return;
  }

  ensureAdminEffectifPanel();
  startSettingsListener();
});

injectStyles();
installEffectifGuards();
startDomObserver();
