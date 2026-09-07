import "./effectif-sync.js?v=9081";

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

const app = getApp();
const auth = getAuth(app);
const db = getFirestore(app);

const HISTORY_LIMIT = 30;

let currentUserAdmin = false;
let currentUserRole = null;
let adminUsers = [];
let latestHistoryItems = [];
let unsubscribeAdminUsers = null;
let unsubscribeAdminHistory = null;

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
    case "stage_archive_dates_updated":
      return "Dates de l’archive corrigées";
    case "stage_comment_saved":
      return "Commentaire stage modifié";
    case "admin_user_access_saved":
      return "Accès utilisateur modifié";
    default:
      return "Action enregistrée";
  }
}

async function loadCurrentUserAccess(user) {
  if (!user?.email) return { role: null, admin: false };

  try {
    const snap = await getDoc(doc(db, "users", user.email));

    if (!snap.exists()) return { role: null, admin: false };

    const data = snap.data();

    return {
      role: data.role || null,
      admin: data.admin === true
    };
  } catch (error) {
    console.warn("Accès admin non lu :", error);
    return { role: null, admin: false };
  }
}

function canSeeAdminPanel() {
  return currentUserAdmin === true;
}

async function addHistory(action, details = {}) {
  if (!auth.currentUser) return;

  await addDoc(collection(db, "stageHistory"), {
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
    console.warn("Historique admin non enregistré :", error);
  }
}

function injectAdminStyles() {
  if (document.getElementById("stageAdminPanelStyles")) return;

  const style = document.createElement("style");
  style.id = "stageAdminPanelStyles";
  style.textContent = `
    .admin-header-btn {
      border-color: rgba(214,180,106,.30) !important;
      background: rgba(214,180,106,.12) !important;
      color: var(--gold2) !important;
    }

    .admin-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 1140;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0,0,0,.68);
      backdrop-filter: blur(16px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease;
    }

    .admin-modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }

    .admin-modal-overlay[hidden] {
      display: none !important;
    }

    .admin-modal-card {
      width: min(980px, 100%);
      max-height: min(86vh, 780px);
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

    .admin-modal-overlay.active .admin-modal-card {
      transform: translateY(0) scale(1);
    }

    .admin-close {
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

    .admin-modal-card h2 {
      margin: 0;
      max-width: 650px;
      font-size: clamp(34px, 5vw, 58px);
      line-height: .9;
      letter-spacing: -.065em;
    }

    .admin-summary {
      margin-top: 18px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .admin-summary-card {
      padding: 14px;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.045);
    }

    .admin-summary-card span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 1000;
      text-transform: uppercase;
    }

    .admin-summary-card strong {
      display: block;
      margin-top: 6px;
      color: var(--gold2);
      font-size: 22px;
      font-weight: 1000;
    }

    .admin-users-list {
      margin-top: 16px;
      display: grid;
      gap: 10px;
    }

    .admin-user-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.2fr) 120px 120px minmax(170px, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 13px;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,.08);
      background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.020));
    }

    .admin-user-row strong {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
      font-size: 13px;
      font-weight: 1000;
    }

    .admin-user-row span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 850;
    }

    .admin-user-row select {
      width: 100%;
      height: 38px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(0,0,0,.30);
      color: var(--text);
      padding: 0 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 1000;
      outline: none;
    }

    .admin-user-row select option {
      background: #101010;
      color: var(--text);
    }

    .admin-user-admin-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 1000;
      cursor: pointer;
    }

    .admin-user-admin-toggle input {
      width: 18px;
      height: 18px;
      accent-color: var(--gold);
      cursor: pointer;
    }

    .admin-user-save-btn {
      height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      border: 1px solid rgba(214,180,106,.30);
      background: rgba(214,180,106,.12);
      color: var(--gold2);
      font-family: inherit;
      font-size: 12px;
      font-weight: 1000;
      cursor: pointer;
      transition: transform .18s ease, background .18s ease, border-color .18s ease;
    }

    .admin-user-save-btn:hover {
      transform: translateY(-1px);
      border-color: rgba(214,180,106,.46);
      background: rgba(214,180,106,.18);
    }

    .admin-user-save-btn:disabled {
      opacity: .6;
      cursor: not-allowed;
      transform: none;
    }

    .admin-empty {
      margin-top: 16px;
      padding: 14px;
      border-radius: 17px;
      border: 1px solid rgba(214,180,106,.18);
      background: rgba(214,180,106,.08);
      color: var(--gold2);
      font-size: 13px;
      font-weight: 900;
    }

    @media (max-width: 850px) {
      .admin-summary,
      .admin-user-row {
        grid-template-columns: 1fr;
      }

      .admin-user-save-btn {
        width: 100%;
      }
    }
  `;

  document.head.appendChild(style);
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

function ensureAdminModal() {
  if (document.getElementById("adminModal")) return;

  document.body.insertAdjacentHTML("beforeend", `
    <div id="adminModal" class="admin-modal-overlay" hidden>
      <div class="admin-modal-card">
        <button type="button" class="admin-close" onclick="window.closeAdminPanel()">×</button>

        <p class="kicker">Admin privé</p>
        <h2>Comptes et accès</h2>

        <div class="admin-summary">
          <div class="admin-summary-card">
            <span>Comptes</span>
            <strong id="adminTotalUsers">0</strong>
          </div>

          <div class="admin-summary-card">
            <span>Profs</span>
            <strong id="adminTotalProfs">0</strong>
          </div>

          <div class="admin-summary-card">
            <span>Admins</span>
            <strong id="adminTotalAdmins">0</strong>
          </div>
        </div>

        <div id="adminUsersList" class="admin-users-list">
          <div class="admin-empty">Chargement des comptes...</div>
        </div>
      </div>
    </div>
  `);
}

function ensureAdminButton() {
  if (!canSeeAdminPanel()) return;
  if (document.getElementById("adminPanelBtn")) return;

  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "adminPanelBtn";
  button.className = "header-btn admin-header-btn";
  button.textContent = "Admin";
  button.addEventListener("click", window.openAdminPanel);

  const logoutBtn = document.getElementById("logoutBtn");

  if (logoutBtn) {
    logoutBtn.insertAdjacentElement("beforebegin", button);
  } else {
    headerActions.appendChild(button);
  }
}

function ensureAdminUi() {
  if (!canSeeAdminPanel()) {
    removeAdminUi();
    return;
  }

  injectAdminStyles();
  ensureAdminModal();
  ensureAdminButton();
  renderAdminPanel();
}

function removeAdminUi() {
  const button = document.getElementById("adminPanelBtn");
  const modal = document.getElementById("adminModal");

  if (button) button.remove();
  if (modal) modal.remove();
}

function getLatestActivityForEmail(email) {
  const match = latestHistoryItems.find(item => {
    return String(item.actor || "").toLowerCase() === String(email || "").toLowerCase();
  });

  if (!match) return "Aucune activité connue";

  return `${getHistoryLabel(match.action)} · ${formatFirestoreDate(match.createdAt)}`;
}

function renderAdminPanel() {
  if (!canSeeAdminPanel()) return;

  const totalUsers = document.getElementById("adminTotalUsers");
  const totalProfs = document.getElementById("adminTotalProfs");
  const totalAdmins = document.getElementById("adminTotalAdmins");
  const list = document.getElementById("adminUsersList");

  if (totalUsers) totalUsers.textContent = String(adminUsers.length);
  if (totalProfs) totalProfs.textContent = String(adminUsers.filter(user => user.role === "prof").length);
  if (totalAdmins) totalAdmins.textContent = String(adminUsers.filter(user => user.admin === true).length);

  if (!list) return;

  if (!adminUsers.length) {
    list.innerHTML = `<div class="admin-empty">Aucun compte dans la collection users.</div>`;
    return;
  }

  const rows = [...adminUsers].sort((a, b) => {
    if (a.admin !== b.admin) return a.admin ? -1 : 1;
    if (a.role !== b.role) return String(a.role).localeCompare(String(b.role), "fr");
    return String(a.email).localeCompare(String(b.email), "fr");
  });

  list.innerHTML = rows.map(user => {
    const role = user.role || "stage";
    const isAdmin = user.admin === true;
    const isCurrentUser = auth.currentUser?.email === user.email;

    return `
      <div class="admin-user-row" data-admin-user-email="${escapeHtml(user.email)}">
        <div>
          <strong title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</strong>
          <span>${isCurrentUser ? "Ton compte" : "Compte utilisateur"}</span>
        </div>

        <select class="admin-user-role">
          <option value="stage" ${role === "stage" ? "selected" : ""}>stage</option>
          <option value="prof" ${role === "prof" ? "selected" : ""}>prof</option>
        </select>

        <label class="admin-user-admin-toggle">
          <input class="admin-user-admin" type="checkbox" ${isAdmin ? "checked" : ""}>
          Admin
        </label>

        <div>
          <strong>${escapeHtml(getLatestActivityForEmail(user.email))}</strong>
          <span>Dernière activité connue</span>
        </div>

        <button type="button" class="admin-user-save-btn">Enregistrer</button>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".admin-user-save-btn").forEach(button => {
    button.addEventListener("click", () => {
      const row = button.closest(".admin-user-row");
      if (!row) return;

      window.saveAdminUserAccess(row.dataset.adminUserEmail, row, button);
    });
  });
}

window.openAdminPanel = function() {
  if (!canSeeAdminPanel()) {
    alert("Accès admin réservé.");
    return;
  }

  ensureAdminUi();
  openModal(document.getElementById("adminModal"));
};

window.closeAdminPanel = function() {
  closeModal(document.getElementById("adminModal"));
};

window.saveAdminUserAccess = async function(email, row, button) {
  if (!canSeeAdminPanel()) {
    alert("Accès admin réservé.");
    return;
  }

  const cleanEmail = String(email || "").trim();
  const role = row?.querySelector(".admin-user-role")?.value || "stage";
  const admin = Boolean(row?.querySelector(".admin-user-admin")?.checked);
  const isCurrentUser = cleanEmail === auth.currentUser?.email;

  if (!cleanEmail) {
    alert("Compte introuvable.");
    return;
  }

  if (isCurrentUser && (role !== "prof" || admin !== true)) {
    alert("Sécurité : tu ne peux pas retirer ton propre accès prof/admin depuis ce panneau.");
    renderAdminPanel();
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = "Sauvegarde...";
  }

  try {
    await setDoc(doc(db, "users", cleanEmail), {
      role,
      admin,
      updatedBy: auth.currentUser?.email || "admin",
      updatedAt: serverTimestamp()
    }, { merge: true });

    await addHistorySafely("admin_user_access_saved", {
      email: cleanEmail,
      role,
      admin
    });
  } catch (error) {
    console.error("Erreur sauvegarde accès admin :", error);
    alert("Impossible de modifier ce compte. Vérifie les règles Firebase.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Enregistrer";
    }
  }
};

function startAdminUsersListener() {
  if (!canSeeAdminPanel()) return;

  injectAdminStyles();
  ensureAdminModal();
  ensureAdminButton();

  if (unsubscribeAdminUsers) return;

  unsubscribeAdminUsers = onSnapshot(
    collection(db, "users"),
    (snap) => {
      adminUsers = [];

      snap.forEach(docSnap => {
        const data = docSnap.data();

        adminUsers.push({
          email: docSnap.id,
          role: data.role || "",
          admin: data.admin === true,
          updatedAt: data.updatedAt || null,
          updatedBy: data.updatedBy || ""
        });
      });

      renderAdminPanel();
    },
    (error) => {
      console.error("Erreur écoute utilisateurs admin :", error);

      const list = document.getElementById("adminUsersList");
      if (list) {
        list.innerHTML = `
          <div class="admin-empty">
            Comptes indisponibles. Vérifie les règles Firebase admin.
          </div>
        `;
      }
    }
  );
}

function startAdminHistoryListener() {
  if (!canSeeAdminPanel()) return;

  if (unsubscribeAdminHistory) return;

  const historyQuery = query(
    collection(db, "stageHistory"),
    orderBy("createdAt", "desc"),
    limit(HISTORY_LIMIT)
  );

  unsubscribeAdminHistory = onSnapshot(
    historyQuery,
    (snap) => {
      latestHistoryItems = [];

      snap.forEach(docSnap => {
        latestHistoryItems.push({
          firebaseId: docSnap.id,
          ...docSnap.data()
        });
      });

      renderAdminPanel();
    },
    (error) => {
      console.error("Erreur écoute historique admin :", error);
    }
  );
}

function stopAdminListeners() {
  if (unsubscribeAdminUsers) {
    unsubscribeAdminUsers();
    unsubscribeAdminUsers = null;
  }

  if (unsubscribeAdminHistory) {
    unsubscribeAdminHistory();
    unsubscribeAdminHistory = null;
  }

  adminUsers = [];
  latestHistoryItems = [];
}

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  window.closeAdminPanel();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUserRole = null;
    currentUserAdmin = false;
    stopAdminListeners();
    removeAdminUi();
    return;
  }

  const access = await loadCurrentUserAccess(user);
  currentUserRole = access.role;
  currentUserAdmin = access.admin;

  if (!canSeeAdminPanel()) {
    stopAdminListeners();
    removeAdminUi();
    return;
  }

  ensureAdminUi();
  setTimeout(ensureAdminUi, 250);
  setTimeout(ensureAdminUi, 1000);
  startAdminUsersListener();
  startAdminHistoryListener();
});
