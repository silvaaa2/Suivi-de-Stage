import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDsEuRjht4ujClPreuT4btpSJKxXSP8I6c",
  authDomain: "universit-4b11e.firebaseapp.com",
  projectId: "universit-4b11e",
  storageBucket: "universit-4b11e.firebasestorage.app",
  messagingSenderId: "11363330953",
  appId: "1:11363330953:web:b08d1b2de1f93a8e11cf58",
  measurementId: "G-Z5B51BQCNL"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STAGE_COLLECTION = "stageValidations";
const EXAM_COLLECTION = "examAnswerStatuses";

const COMPANIES = [
  { id: "bennys", name: "Benny's" },
  { id: "lsc", name: "LSC" },
  { id: "paleto", name: "Paleto Garage" },
  { id: "harmony", name: "Harmony Repair" },
  { id: "cayo", name: "Cayo Garage" },
  { id: "portolina", name: "Portolina Mechanic" },
  { id: "favelas", name: "Favelas Repair" }
];

const loginSection = document.getElementById("loginSection");
const dashboard = document.getElementById("dashboard");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");
const loginBtnText = loginBtn.querySelector(".btn-text");

const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");

const companyGrid = document.getElementById("companyGrid");
const examList = document.getElementById("examList");

let stageValidations = [];
let examParticipants = [];
let currentUserRole = null;

function normalizeIdUnique(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeJsString(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

function setLoginLoading(isLoading) {
  loginBtn.disabled = isLoading;
  loginBtn.classList.toggle("loading", isLoading);
  loginBtnText.textContent = isLoading ? "Connexion..." : "Connexion";
}

function showLogin() {
  loginSection.hidden = false;
  dashboard.hidden = true;
  refreshBtn.hidden = true;
  logoutBtn.hidden = true;

  setLoginLoading(false);
}

function showDashboard() {
  loginSection.hidden = true;
  dashboard.hidden = false;
  refreshBtn.hidden = false;
  logoutBtn.hidden = false;
}

async function getUserRole(user) {
  if (!user?.email) return null;

  try {
    const userRef = doc(db, "users", user.email);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) return null;

    return userSnap.data().role || null;
  } catch (error) {
    console.error("Erreur lecture rôle utilisateur :", error);
    return null;
  }
}

function isAllowedStageRole(role) {
  return role === "prof" || role === "stage";
}

async function refuseAccess(user) {
  console.warn("Accès refusé site stage :", user?.email || "email inconnu");

  currentUserRole = null;

  try {
    await signOut(auth);
  } catch (error) {
    console.error("Erreur déconnexion après refus :", error);
  }

  loginError.textContent = "Accès refusé. Ce compte n’est pas autorisé sur le suivi de stage.";
  showLogin();
}

function buildStageDocId(companyId, normalizedIdUnique) {
  return `${companyId}__${normalizedIdUnique}`;
}

async function loadStageValidations() {
  const snap = await getDocs(collection(db, STAGE_COLLECTION));

  stageValidations = [];

  snap.forEach(docSnap => {
    stageValidations.push({
      firebaseId: docSnap.id,
      ...docSnap.data()
    });
  });
}

async function loadExamParticipants() {
  const snap = await getDocs(collection(db, EXAM_COLLECTION));

  examParticipants = [];

  snap.forEach(docSnap => {
    const data = docSnap.data();

    if (data.archived === true) return;

    const normalizedId =
      data.normalizedIdUnique ||
      normalizeIdUnique(data.idUnique || "");

    if (!normalizedId) return;

    examParticipants.push({
      firebaseId: docSnap.id,
      idUnique: data.idUnique || normalizedId,
      normalizedIdUnique: normalizedId,
      studentName: data.studentName || "Nom non renseigné",
      totalScore: Number(data.totalScore || 0),
      maxScore: Number(data.maxScore || 50),
      status: data.status || "pending"
    });
  });

  examParticipants.sort((a, b) => {
    return String(a.studentName).localeCompare(String(b.studentName), "fr");
  });
}

function getStagesByCompany(companyId) {
  return stageValidations
    .filter(item => item.companyId === companyId)
    .sort((a, b) => String(a.idUnique).localeCompare(String(b.idUnique), "fr"));
}

function hasStageForId(normalizedIdUnique) {
  return stageValidations.some(item => item.normalizedIdUnique === normalizedIdUnique);
}

function getStageCompanyForId(normalizedIdUnique) {
  const found = stageValidations.find(item => item.normalizedIdUnique === normalizedIdUnique);
  return found?.companyName || "";
}

function getStatusLabel(status) {
  switch (status) {
    case "approved":
      return "Approuvé";
    case "rejected":
      return "Refusé";
    default:
      return "En attente";
  }
}

function renderCompanies() {
  companyGrid.innerHTML = COMPANIES.map(company => {
    const entries = getStagesByCompany(company.id);

    const rowsHtml = entries.length
      ? entries.map(entry => `
          <div class="stage-id-row">
            <strong>${escapeHtml(entry.idUnique)}</strong>
            <button
              type="button"
              data-delete-stage
              data-doc-id="${escapeHtml(entry.firebaseId)}"
              title="Supprimer"
            >
              ×
            </button>
          </div>
        `).join("")
      : `<div class="empty-row">Aucun ID enregistré.</div>`;

    return `
      <article class="company-column">
        <div class="company-head">${escapeHtml(company.name)}</div>
        <div class="company-subhead">ID Unique</div>

        <form class="company-form" data-company-form data-company-id="${escapeHtml(company.id)}">
          <input type="text" placeholder="Ex: 322644" inputmode="numeric" required>
          <button type="submit">+</button>
        </form>

        <div class="stage-id-list">
          ${rowsHtml}
        </div>
      </article>
    `;
  }).join("");

  bindCompanyForms();
}

function renderExamParticipants() {
  if (!examParticipants.length) {
    examList.innerHTML = `
      <div class="loading-box">
        Aucun participant d’examen trouvé dans Firebase.<br>
        Il faudra ouvrir la page examen pour sauvegarder idUnique + studentName.
      </div>
    `;
    return;
  }

  examList.innerHTML = examParticipants.map(participant => {
    const hasStage = hasStageForId(participant.normalizedIdUnique);
    const companyName = getStageCompanyForId(participant.normalizedIdUnique);
    const statusLabel = getStatusLabel(participant.status);

    const safeDocIdHtml = escapeHtml(participant.firebaseId);
    const safeDocIdJs = escapeJsString(participant.firebaseId);
    const safeStudentNameJs = escapeJsString(participant.studentName);

    const deleteButton = currentUserRole === "prof"
      ? `
        <button
          type="button"
          class="delete-exam-participant-btn"
          onclick="window.deleteExamParticipantFromStage('${safeDocIdJs}', '${safeStudentNameJs}')"
          title="Supprimer le participant"
        >
          ×
        </button>
      `
      : "";

    return `
      <div class="exam-row ${hasStage ? "stage-ok" : ""}" data-exam-row-id="${safeDocIdHtml}">
        <strong>${escapeHtml(participant.idUnique)}</strong>

        <div class="exam-name">
          <b>${escapeHtml(participant.studentName)}</b>
          <span>${escapeHtml(participant.totalScore)} / ${escapeHtml(participant.maxScore)} · ${escapeHtml(statusLabel)}</span>
        </div>

        <span class="badge ${hasStage ? "ok" : "no"}">
          ${hasStage ? `✅ ${escapeHtml(companyName)}` : "Aucun stage"}
        </span>

        ${deleteButton}
      </div>
    `;
  }).join("");
}

async function addStageValidation(companyId, idUnique) {
  const company = COMPANIES.find(item => item.id === companyId);
  if (!company) return;

  const normalizedIdUnique = normalizeIdUnique(idUnique);

  if (!normalizedIdUnique) {
    alert("ID Unique invalide.");
    return;
  }

  const alreadyExists = stageValidations.some(item => {
    return item.companyId === companyId && item.normalizedIdUnique === normalizedIdUnique;
  });

  if (alreadyExists) {
    alert("Cet ID est déjà enregistré dans cette entreprise.");
    return;
  }

  const docId = buildStageDocId(companyId, normalizedIdUnique);
  const ref = doc(db, STAGE_COLLECTION, docId);

  await setDoc(ref, {
    idUnique: String(idUnique).trim(),
    normalizedIdUnique,
    companyId: company.id,
    companyName: company.name,
    status: "approved",
    addedBy: auth.currentUser?.email || "compte stage",
    addedByRole: currentUserRole || "unknown",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function deleteStageValidation(docId) {
  if (!docId) {
    alert("ID Firebase introuvable, impossible de supprimer.");
    return false;
  }

  if (!confirm("Supprimer cet ID de stage ?")) {
    return false;
  }

  await deleteDoc(doc(db, STAGE_COLLECTION, docId));
  return true;
}

function bindCompanyForms() {
  document.querySelectorAll("[data-company-form]").forEach(form => {
    form.addEventListener("submit", async event => {
      event.preventDefault();

      const companyId = form.dataset.companyId;
      const input = form.querySelector("input");
      const idUnique = input.value.trim();

      if (!idUnique) return;

      const submitBtn = form.querySelector("button");
      submitBtn.disabled = true;

      try {
        await addStageValidation(companyId, idUnique);
        input.value = "";
        await refreshAll();
      } catch (error) {
        console.error("Erreur ajout ID stage :", error);
        alert("Impossible d’ajouter cet ID. Vérifie les règles Firebase.");
      } finally {
        submitBtn.disabled = false;
      }
    });
  });
}

/* Suppression des ID de stage */
document.addEventListener("click", async event => {
  const stageDeleteButton = event.target.closest("[data-delete-stage]");
  if (!stageDeleteButton) return;

  event.preventDefault();
  event.stopPropagation();

  const docId = stageDeleteButton.dataset.docId;

  if (!docId) {
    alert("Document Firebase introuvable.");
    return;
  }

  const oldText = stageDeleteButton.textContent;
  stageDeleteButton.disabled = true;
  stageDeleteButton.textContent = "...";

  try {
    const deleted = await deleteStageValidation(docId);

    if (deleted) {
      await refreshAll();
    } else {
      stageDeleteButton.disabled = false;
      stageDeleteButton.textContent = oldText || "×";
    }
  } catch (error) {
    console.error("Erreur suppression ID stage :", error);
    alert(`Erreur suppression ID stage : ${error.code || error.message}`);

    stageDeleteButton.disabled = false;
    stageDeleteButton.textContent = oldText || "×";
  }
});

/* Suppression / masquage des participants examen */
window.deleteExamParticipantFromStage = async function(docId, studentName) {
  console.log("DELETE INLINE CLICK OK", {
    docId,
    studentName,
    currentUserRole,
    user: auth.currentUser?.email
  });

  if (currentUserRole !== "prof") {
    alert("Seul un compte professeur peut supprimer un participant.");
    return;
  }

  if (!docId) {
    alert("Document participant introuvable.");
    return;
  }

  try {
    const ref = doc(db, EXAM_COLLECTION, docId);

    await setDoc(ref, {
      archived: true,
      archivedBy: auth.currentUser?.email || "professeur inconnu",
      archivedAt: serverTimestamp()
    }, { merge: true });

    const row = document.querySelector(`[data-exam-row-id="${CSS.escape(docId)}"]`);
    if (row) row.remove();

    console.log("Participant masqué avec succès :", studentName);

    await refreshAll();

  } catch (error) {
    console.error("Erreur suppression participant :", error);
    alert(`Erreur suppression : ${error.code || error.message}`);
  }
};

async function refreshAll() {
  companyGrid.innerHTML = `<div class="loading-box">Chargement des stages...</div>`;
  examList.innerHTML = `<div class="loading-box">Chargement des participants...</div>`;

  await loadStageValidations();
  await loadExamParticipants();

  renderCompanies();
  renderExamParticipants();
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  loginError.textContent = "";
  setLoginLoading(true);

  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const user = credential.user;

    const role = await getUserRole(user);

    if (!isAllowedStageRole(role)) {
      await refuseAccess(user);
      return;
    }

    currentUserRole = role;
    showDashboard();
    await refreshAll();

  } catch (error) {
    console.error("Erreur connexion Firebase :", error.code, error.message);

    if (error.code === "auth/invalid-credential") {
      loginError.textContent = "Email ou mot de passe incorrect.";
    } else if (error.code === "auth/wrong-password") {
      loginError.textContent = "Mot de passe incorrect.";
    } else if (error.code === "auth/user-not-found") {
      loginError.textContent = "Compte introuvable.";
    } else if (error.code === "auth/invalid-email") {
      loginError.textContent = "Adresse e-mail invalide.";
    } else if (error.code === "auth/unauthorized-domain") {
      loginError.textContent = "Domaine Vercel non autorisé dans Firebase.";
    } else if (error.code === "auth/operation-not-allowed") {
      loginError.textContent = "Connexion email/mot de passe désactivée dans Firebase.";
    } else if (error.code === "auth/network-request-failed") {
      loginError.textContent = "Erreur réseau.";
    } else if (error.code === "permission-denied") {
      loginError.textContent = "Accès refusé. Rôle utilisateur introuvable ou non autorisé.";
    } else {
      loginError.textContent = `Erreur : ${error.code}`;
    }

    setLoginLoading(false);
  }
});

logoutBtn.addEventListener("click", async () => {
  currentUserRole = null;
  await signOut(auth);
});

refreshBtn.addEventListener("click", async () => {
  await refreshAll();
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    currentUserRole = null;
    showLogin();
    return;
  }

  const role = await getUserRole(user);

  if (!isAllowedStageRole(role)) {
    await refuseAccess(user);
    return;
  }

  currentUserRole = role;
  showDashboard();

  try {
    await refreshAll();
  } catch (error) {
    console.error("Erreur chargement dashboard stage :", error);

    companyGrid.innerHTML = `
      <div class="loading-box">
        Erreur de chargement des stages.<br>
        Vérifie les règles Firestore.
      </div>
    `;

    examList.innerHTML = `
      <div class="loading-box">
        Erreur de chargement des examens.<br>
        Vérifie les règles Firestore.
      </div>
    `;
  }
});
