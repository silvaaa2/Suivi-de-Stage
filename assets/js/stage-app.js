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
  bindDeleteButtons();
}

function renderExamParticipants() {
  if (!examParticipants.length) {
    examList.innerHTML = `
      <div class="loading-box">
        Aucun participant d’examen trouvé dans Firebase.<br>
        Il faudra patcher le site examen pour sauvegarder idUnique + studentName.
      </div>
    `;
    return;
  }

  examList.innerHTML = examParticipants.map(participant => {
    const hasStage = hasStageForId(participant.normalizedIdUnique);
    const companyName = getStageCompanyForId(participant.normalizedIdUnique);
    const statusLabel = getStatusLabel(participant.status);

    return `
      <div class="exam-row ${hasStage ? "stage-ok" : ""}">
        <strong>${escapeHtml(participant.idUnique)}</strong>

        <div class="exam-name">
          <b>${escapeHtml(participant.studentName)}</b>
          <span>${escapeHtml(participant.totalScore)} / ${escapeHtml(participant.maxScore)} · ${escapeHtml(statusLabel)}</span>
        </div>

        <span class="badge ${hasStage ? "ok" : "no"}">
          ${hasStage ? `✅ ${escapeHtml(companyName)}` : "Aucun stage"}
        </span>
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
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function deleteStageValidation(docId) {
  if (!docId) {
    alert("ID Firebase introuvable, impossible de supprimer.");
    return;
  }

  const confirmed = confirm("Supprimer cet ID de stage ?");
  if (!confirmed) return;

  await deleteDoc(doc(db, STAGE_COLLECTION, docId));
}

function bindDeleteButtons() {
  document.querySelectorAll("[data-delete-stage]").forEach(button => {
    button.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const docId = button.dataset.docId;

      if (!docId) {
        alert("Document Firebase introuvable.");
        return;
      }

      button.disabled = true;
      button.textContent = "...";

      try {
        await deleteStageValidation(docId);
        await refreshAll();
      } catch (error) {
        console.error("Erreur suppression ID stage :", error);
        alert("Impossible de supprimer cet ID. Vérifie les règles Firestore.");
        button.disabled = false;
        button.textContent = "×";
      }
    };
  });
}

function bindDeleteButtons() {
  document.querySelectorAll("[data-delete-stage]").forEach(button => {
    button.addEventListener("click", async () => {
      const docId = button.dataset.docId;
      if (!docId) return;

      try {
        await deleteStageValidation(docId);
        await refreshAll();
      } catch (error) {
        console.error("Erreur suppression ID stage :", error);
        alert("Impossible de supprimer cet ID.");
      }
    });
  });
}

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
    await signInWithEmailAndPassword(auth, email, password);
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
    } else {
      loginError.textContent = `Erreur : ${error.code}`;
    }

    setLoginLoading(false);
  }
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
});

refreshBtn.addEventListener("click", async () => {
  await refreshAll();
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    showLogin();
    return;
  }

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
