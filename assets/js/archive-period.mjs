export function normalizeArchiveDateInput(value) {
  const raw = String(value || "").trim();
  const local = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!local && !iso) return null;

  const [year, month, day] = local
    ? [Number(local[3]), Number(local[2]), Number(local[1])]
    : [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return { iso: `${year}-${mm}-${dd}`, display: `${dd}/${mm}/${year}` };
}

export function buildArchivePeriod(startValue, endValue) {
  const start = normalizeArchiveDateInput(startValue);
  const end = normalizeArchiveDateInput(endValue);
  if (!start || !end) throw new Error("Renseignez deux dates valides.");
  if (end.iso < start.iso) throw new Error("La date de fin doit être égale ou postérieure à la date de début.");
  return {
    title: `Archive du ${start.display} au ${end.display}`,
    startDate: start.iso,
    endDate: end.iso,
    startDisplay: start.display,
    endDisplay: end.display
  };
}
