import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeArchiveDateInput, buildArchivePeriod } from "../assets/js/archive-period.mjs";

const source = await readFile(new URL("../assets/js/stage-app.js", import.meta.url), "utf8");
const saveFunction = source.slice(source.indexOf("async function saveStageArchivePeriod("), source.indexOf("let archiveDateEditorArchive"));
const renderFunction = source.slice(source.indexOf("function renderArchiveDateButton("), source.indexOf("function getArchiveStageCompanyForId("));
const createFunction = source.slice(source.indexOf("async function createStageArchive("), source.indexOf("window.openStageArchive ="));

test("les dates sont validées au calendrier et gardent le même jour sans conversion locale", () => {
  assert.deepEqual(normalizeArchiveDateInput("7/9/2026"), { iso: "2026-09-07", display: "07/09/2026" });
  assert.deepEqual(normalizeArchiveDateInput("2026-09-07"), { iso: "2026-09-07", display: "07/09/2026" });
  assert.equal(normalizeArchiveDateInput("29/02/2026"), null);
  assert.equal(normalizeArchiveDateInput("31/04/2026"), null);
  assert.equal(normalizeArchiveDateInput("00/09/2026"), null);
  assert.equal(normalizeArchiveDateInput("2026-13-01"), null);
  assert.equal(normalizeArchiveDateInput(""), null);
  assert.equal(normalizeArchiveDateInput("29/02/2028").iso, "2028-02-29");
});

test("une période inversée est refusée et une archive d'une journée est permise", () => {
  assert.throws(() => buildArchivePeriod("2026-09-07", "2026-09-06"), /date de fin/);
  assert.throws(() => buildArchivePeriod("31/02/2026", "2026-09-06"), /dates valides/);
  assert.equal(buildArchivePeriod("2026-09-07", "2026-09-07").title, "Archive du 07/09/2026 au 07/09/2026");
});

function scenario({ cachedAdmin = true, serverAdmin = true, missing = false, changed = false, offline = false } = {}) {
  const archive = {
    firebaseId: "archive_2026-08-24_2026-09-06",
    startDate: "2026-08-24", endDate: "2026-09-06",
    startDisplay: "24/08/2026", endDisplay: "06/09/2026",
    title: "Archive du 24/08/2026 au 06/09/2026",
    stageValidations: [{ idUnique: "123", companyId: "paleto" }],
    examParticipants: [{ idUnique: "123", totalScore: 45, maxScore: 50 }],
    createdAt: "original timestamp", archivedBy: "original creator", summary: { totalStages: 1, totalExams: 1 }
  };
  const stored = structuredClone(archive);
  if (changed) stored.startDate = "2026-08-25";
  const updates = [];
  const histories = [];
  const context = vm.createContext({
    auth: { currentUser: { email: "admin@example.test", uid: "admin-test" } },
    currentUserAdmin: cachedAdmin, db: {}, STAGE_ARCHIVE_COLLECTION: "stageArchives",
    buildArchivePeriod,
    doc: (...args) => args.length === 1 ? "stageHistory/new" : `${args[1]}/${args[2]}`,
    collection: (_db, name) => name,
    serverTimestamp: () => "server timestamp",
    getArchiveDisplayTitle: item => item.title,
    runTransaction: async (_db, callback) => {
      if (offline) throw Object.assign(new Error("Network unavailable"), { code: "unavailable" });
      await callback({
        get: async ref => ref.startsWith("users/")
          ? { exists: () => true, data: () => ({ role: "prof", admin: serverAdmin }) }
          : { exists: () => !missing, data: () => structuredClone(stored) },
        update: (ref, patch) => updates.push({ ref, patch }),
        set: (ref, data) => histories.push({ ref, data })
      });
      for (const { patch } of updates) Object.assign(stored, patch);
    },
    escapeHtml: text => String(text)
  });
  vm.runInContext(saveFunction + renderFunction, context);
  return { archive, stored, updates, histories, context };
}

test("l'admin corrige uniquement la période en conservant l'ID, les stages, les notes et la date de création", async () => {
  const s = scenario();
  await s.context.saveStageArchivePeriod(s.archive, "2026-08-25", "2026-09-07");
  assert.equal(s.updates.length, 1);
  assert.equal(s.updates[0].ref, `stageArchives/${s.archive.firebaseId}`);
  for (const field of ["firebaseId", "stageValidations", "examParticipants", "createdAt", "archivedBy", "summary"]) {
    assert.deepEqual(s.stored[field], s.archive[field]);
  }
  assert.equal(s.stored.startDate, "2026-08-25");
  assert.equal(s.stored.endDisplay, "07/09/2026");
  assert.equal(s.histories[0].data.details.previousPeriod, s.archive.title);
  assert.equal(s.histories[0].data.details.period, s.stored.title);
  assert.equal(s.histories[0].data.actor, "admin@example.test");
});

test("prof et stage n'ont aucun bouton et une tentative directe est refusée", async () => {
  const s = scenario({ cachedAdmin: false });
  assert.equal(s.context.renderArchiveDateButton(s.archive), "");
  await assert.rejects(() => s.context.saveStageArchivePeriod(s.archive, "2026-08-25", "2026-09-07"), /administrateur/);
  assert.equal(s.updates.length, 0);
});

test("le droit admin est relu au serveur, y compris s'il a été retiré depuis la connexion", async () => {
  for (const serverAdmin of [false, "true", 1, undefined]) {
    const s = scenario({ serverAdmin: serverAdmin ?? false });
    await assert.rejects(() => s.context.saveStageArchivePeriod(s.archive, "2026-08-25", "2026-09-07"), /administrateur/);
    assert.equal(s.updates.length, 0);
  }
});

test("une suppression, une modification concurrente ou une panne réseau ne remplace pas l'archive", async () => {
  for (const options of [{ missing: true }, { changed: true }, { offline: true }]) {
    const s = scenario(options);
    await assert.rejects(() => s.context.saveStageArchivePeriod(s.archive, "2026-08-25", "2026-09-07"));
    assert.equal(s.updates.length, 0);
    assert.equal(s.histories.length, 0);
  }
});

test("la création d'un cursus ne peut pas écraser une archive dont les dates ont été corrigées", async () => {
  const s = scenario({ changed: true });
  Object.assign(s.context, {
    stageValidations: [], examParticipants: [],
    buildArchiveDocId: () => s.archive.firebaseId,
    buildArchiveSummary: () => ({ totalStages: 0, totalExams: 0 })
  });
  vm.runInContext(createFunction, s.context);
  await assert.rejects(() => s.context.createStageArchive(
    normalizeArchiveDateInput('2026-08-24'), normalizeArchiveDateInput('2026-09-06')
  ), /ne sera pas remplacée/);
  assert.equal(s.histories.length, 0);
  assert.equal(s.updates.length, 0);
  assert.equal(s.stored.examParticipants[0].totalScore, 45);
});
