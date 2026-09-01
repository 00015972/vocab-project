function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeSubtopic(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'general' || value === 'other' || value === 'misc') return null;
  return value;
}

function normalizeAccuracy(raw, fallback = NaN) {
  const value = asNumber(raw, NaN);
  if (!Number.isFinite(value)) return fallback;
  // Support both 0..1 and 0..100 accuracy inputs.
  if (value >= 0 && value <= 1) return value * 100;
  return value;
}

function normalizePerfEntry(entry = {}, index = 0) {
  const subtopic = normalizeSubtopic(
    entry.subtopic
    || entry.topic
    || entry.subSkill
    || entry.label
    || entry.domain
    || entry.tag
    || entry.mode
  );
  if (!subtopic) return null;

  const totalCountRaw = asNumber(entry.totalCount, NaN);
  const correctCountRaw = asNumber(entry.correctCount, NaN);
  const correctness = entry.correctness;
  const isCorrect = entry.isCorrect;
  const booleanCorrect = typeof correctness === 'boolean'
    ? correctness
    : (typeof isCorrect === 'boolean' ? isCorrect : null);

  let totalCount = Number.isFinite(totalCountRaw) ? Math.max(1, Math.floor(totalCountRaw)) : null;
  let correctCount = Number.isFinite(correctCountRaw) ? Math.max(0, Math.floor(correctCountRaw)) : null;

  if (booleanCorrect !== null) {
    totalCount = totalCount || 1;
    correctCount = booleanCorrect ? 1 : 0;
  }

  const fallbackAccuracy = (Number.isFinite(correctCount) && Number.isFinite(totalCount) && totalCount > 0)
    ? (correctCount / totalCount) * 100
    : NaN;
  const accuracy = clamp(normalizeAccuracy(entry.accuracy, fallbackAccuracy), 0, 100, 0);

  if (!Number.isFinite(totalCount) || totalCount <= 0) totalCount = 1;
  if (!Number.isFinite(correctCount)) {
    correctCount = Math.round((accuracy / 100) * totalCount);
  }
  correctCount = Math.min(Math.max(0, correctCount), totalCount);

  return {
    subtopic,
    totalCount,
    correctCount,
    accuracy,
    at: toIsoOrNull(entry.at || entry.attemptedAt || entry.createdAt || entry.updatedAt || entry.lastAttemptAt || entry.lastReviewedAt),
    index,
  };
}

function toSeverity(accuracyPct, thresholdPct) {
  const deficit = Math.max(0, thresholdPct - accuracyPct);
  if (deficit >= 20) return 'high';
  if (deficit >= 10) return 'medium';
  return 'low';
}

function detectSubtopicStruggle(perfWindow, options = {}) {
  const thresholdPct = clamp(asNumber(options.accuracyThresholdPct, 50), 0, 100, 50);
  const recentWindow = Math.max(1, Math.floor(asNumber(options.recentWindow, 12)));
  const minAttempts = Math.max(1, Math.floor(asNumber(options.minAttempts, 4)));

  const normalized = (Array.isArray(perfWindow) ? perfWindow : [])
    .map((entry, index) => normalizePerfEntry(entry, index))
    .filter(Boolean)
    .sort((a, b) => {
      const aAt = a.at ? new Date(a.at).getTime() : -1;
      const bAt = b.at ? new Date(b.at).getTime() : -1;
      if (aAt !== bAt) return bAt - aAt;
      return b.index - a.index;
    });

  const bySubtopic = new Map();
  normalized.forEach((entry) => {
    const list = bySubtopic.get(entry.subtopic) || [];
    list.push(entry);
    bySubtopic.set(entry.subtopic, list);
  });

  let consideredEntries = 0;
  const summaries = Array.from(bySubtopic.entries()).map(([subtopic, entries]) => {
    const windowed = entries.slice(0, recentWindow);
    consideredEntries += windowed.length;

    const attempts = windowed.reduce((sum, item) => sum + Math.max(0, asNumber(item.totalCount, 0)), 0);
    const correct = Math.min(attempts, windowed.reduce((sum, item) => sum + Math.max(0, asNumber(item.correctCount, 0)), 0));
    const accuracyPct = attempts > 0 ? Number(((correct / attempts) * 100).toFixed(2)) : 0;
    const incorrect = Math.max(0, attempts - correct);
    const eligible = attempts >= minAttempts;
    const struggling = eligible && accuracyPct < thresholdPct;
    const confidence = Number(clamp(attempts / Math.max(minAttempts * 2, 1), 0, 1, 0).toFixed(4));
    const lastSeenAt = windowed[0]?.at || null;

    return {
      subtopic,
      attempts,
      correct,
      incorrect,
      accuracyPct,
      thresholdPct,
      windowEntries: windowed.length,
      eligible,
      struggling,
      confidence,
      severity: toSeverity(accuracyPct, thresholdPct),
      deficitPct: Number(Math.max(0, thresholdPct - accuracyPct).toFixed(2)),
      lastSeenAt,
    };
  });

  summaries.sort((a, b) => {
    if (a.struggling !== b.struggling) return a.struggling ? -1 : 1;
    if (a.accuracyPct !== b.accuracyPct) return a.accuracyPct - b.accuracyPct;
    if (b.attempts !== a.attempts) return b.attempts - a.attempts;
    return a.subtopic.localeCompare(b.subtopic);
  });

  const strugglingSubtopics = summaries.filter((row) => row.struggling);

  return {
    active: strugglingSubtopics.length > 0,
    thresholdPct,
    minAttempts,
    recentWindow,
    totalEntries: normalized.length,
    consideredEntries,
    subtopicCount: summaries.length,
    primarySubtopic: strugglingSubtopics[0] || null,
    strugglingSubtopics,
    summaries,
  };
}

module.exports = {
  detectSubtopicStruggle,
};
