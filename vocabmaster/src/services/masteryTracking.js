function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function toIsoDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeMasterySession(input = {}, fallbackSessionId = '') {
  const correctCount = Math.max(0, Math.floor(asNumber(input.correctCount, input.correct ? 1 : 0)));
  const totalCount = Math.max(1, Math.floor(asNumber(input.totalCount, 1)));
  const boundedCorrect = Math.min(correctCount, totalCount);
  const accuracy = clamp(
    Number.isFinite(Number(input.accuracy))
      ? Number(input.accuracy)
      : (boundedCorrect / totalCount) * 100,
    0,
    100,
    0
  );

  return {
    sessionId: String(input.sessionId || fallbackSessionId || '').trim(),
    sessionAt: toIsoDate(input.sessionAt || input.completedAt || input.createdAt || new Date()),
    correctCount: boundedCorrect,
    totalCount,
    accuracy: Number(accuracy.toFixed(2)),
    mode: String(input.mode || '').trim().toLowerCase() || null,
    responseTimeMs: Math.max(0, Math.round(asNumber(input.responseTimeMs, 0))),
  };
}

function normalizeMasteryHistory(history = []) {
  const bySessionId = new Map();

  for (const entry of Array.isArray(history) ? history : []) {
    const normalized = normalizeMasterySession(entry, entry?.sessionId);
    if (!normalized.sessionId) continue;

    const existing = bySessionId.get(normalized.sessionId);
    if (!existing) {
      bySessionId.set(normalized.sessionId, normalized);
      continue;
    }

    const currentAt = new Date(normalized.sessionAt).getTime();
    const previousAt = new Date(existing.sessionAt).getTime();
    if (currentAt >= previousAt) {
      bySessionId.set(normalized.sessionId, {
        ...existing,
        ...normalized,
      });
    }
  }

  return Array.from(bySessionId.values()).sort((a, b) => new Date(a.sessionAt) - new Date(b.sessionAt));
}

function averageAccuracy(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const sum = entries.reduce((total, entry) => total + clamp(entry?.accuracy, 0, 100, 0), 0);
  return Number((sum / entries.length).toFixed(2));
}

function countTrailingPassingSessions(entries = [], threshold = 80) {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (clamp(entries[index]?.accuracy, 0, 100, 0) < threshold) break;
    count += 1;
  }
  return count;
}

function isMasteredItem(item) {
  if (!item || typeof item !== 'object') return false;
  const status = String(item.masteryStatus || item?.adaptiveMetrics?.masteryStatus || item.learningStatus || '').toLowerCase();
  return status === 'mastered' || !!item?.adaptiveMetrics?.masteredAt;
}

function updateMasteryStatus(wordProgress = {}) {
  if (!wordProgress || typeof wordProgress !== 'object') return null;

  const adaptive = wordProgress.adaptiveMetrics && typeof wordProgress.adaptiveMetrics === 'object'
    ? wordProgress.adaptiveMetrics
    : {};
  const options = wordProgress.masteryOptions && typeof wordProgress.masteryOptions === 'object'
    ? wordProgress.masteryOptions
    : {};
  const historySource = Array.isArray(adaptive.masteryHistory)
    ? adaptive.masteryHistory
    : Array.isArray(wordProgress.masteryHistory)
      ? wordProgress.masteryHistory
      : [];
  const existingHistory = normalizeMasteryHistory(historySource);
  const currentSession = wordProgress.masterySession || wordProgress.sessionSummary || null;

  if (currentSession) {
    const normalizedCurrent = normalizeMasterySession(currentSession, currentSession.sessionId || wordProgress.sessionId || wordProgress._id || wordProgress.wordId || '');
    if (normalizedCurrent.sessionId) {
      const index = existingHistory.findIndex((entry) => String(entry.sessionId) === normalizedCurrent.sessionId);
      if (index >= 0) {
        existingHistory[index] = normalizedCurrent;
      } else {
        existingHistory.push(normalizedCurrent);
      }
    }
  }

  const cappedHistory = existingHistory.slice(-Math.max(3, Math.min(12, asNumber(options.historyLimit, 12))));
  const masteryThreshold = clamp(options.accuracyThreshold, 0, 100, 80);
  const requiredSessions = Math.max(3, Math.floor(asNumber(options.requiredSessions, 3)));
  const rollingWindow = Math.max(3, Math.floor(asNumber(options.rollingWindow, 3)));
  const minimumSpreadDays = Math.max(2, Math.floor(asNumber(options.minimumSpreadDays, 2)));

  const qualifyingSessions = cappedHistory.filter((entry) => clamp(entry.accuracy, 0, 100, 0) >= masteryThreshold);
  const recentWindow = cappedHistory.slice(-rollingWindow);
  const recentAccuracy = averageAccuracy(recentWindow);
  const trailingPassingSessions = countTrailingPassingSessions(cappedHistory, masteryThreshold);

  const qualifyingDates = qualifyingSessions.map((entry) => dayKey(entry.sessionAt)).filter(Boolean);
  const uniqueDays = new Set(qualifyingDates);
  const firstQualifying = qualifyingSessions[0] || null;
  const lastQualifying = qualifyingSessions[qualifyingSessions.length - 1] || null;
  const spreadDays = firstQualifying && lastQualifying
    ? Math.max(0, Math.round((new Date(lastQualifying.sessionAt).getTime() - new Date(firstQualifying.sessionAt).getTime()) / 86400000))
    : 0;

  const mastered = qualifyingSessions.length >= requiredSessions
    && uniqueDays.size >= requiredSessions
    && spreadDays >= minimumSpreadDays
    && recentAccuracy >= masteryThreshold;

  const previousStatus = String(adaptive.masteryStatus || wordProgress.masteryStatus || wordProgress.learningStatus || 'locked').toLowerCase();
  const masteryStatus = mastered
    ? 'mastered'
    : previousStatus === 'mastered'
      ? 'mastered'
      : qualifyingSessions.length > 0
        ? 'in_progress'
        : 'locked';

  const nowIso = new Date().toISOString();
  const masteredAt = mastered
    ? (adaptive.masteredAt || wordProgress.masteredAt || nowIso)
    : (adaptive.masteredAt || wordProgress.masteredAt || null);

  wordProgress.adaptiveMetrics = {
    ...adaptive,
    masteryHistory: cappedHistory,
    masteryStatus,
    masteryUpdatedAt: nowIso,
    masteryRecentAccuracy: recentAccuracy,
    masterySessionCount: cappedHistory.length,
    masteryQualifyingSessions: qualifyingSessions.length,
    masteryDistinctDays: uniqueDays.size,
    masterySpreadDays: spreadDays,
    masteredAt,
  };

  if (masteryStatus === 'mastered') {
    wordProgress.learningStatus = 'mastered';
  } else if (String(wordProgress.learningStatus || '').toLowerCase() !== 'mastered') {
    wordProgress.learningStatus = qualifyingSessions.length > 0 ? 'in_progress' : 'locked';
  }

  return {
    mastered,
    masteryStatus,
    masteryThreshold,
    requiredSessions,
    rollingWindow,
    recentAccuracy,
    trailingPassingSessions,
    qualifyingSessions: qualifyingSessions.length,
    uniqueDays: uniqueDays.size,
    spreadDays,
    history: cappedHistory,
  };
}

function computeModuleMastery(moduleStats = {}) {
  const items = Array.isArray(moduleStats.items)
    ? moduleStats.items
    : Array.isArray(moduleStats.words)
      ? moduleStats.words
      : Array.isArray(moduleStats.lessons)
        ? moduleStats.lessons
        : [];
  const sessions = normalizeMasteryHistory(
    Array.isArray(moduleStats.sessionHistory)
      ? moduleStats.sessionHistory
      : Array.isArray(moduleStats.sessions)
        ? moduleStats.sessions
        : Array.isArray(moduleStats.recentSessions)
          ? moduleStats.recentSessions
          : []
  );

  const masteryThreshold = clamp(moduleStats.accuracyThreshold, 0, 100, 80);
  const requiredConsecutiveSessions = Math.max(3, Math.floor(asNumber(moduleStats.requiredConsecutiveSessions, 3)));
  const rollingWindow = Math.max(3, Math.floor(asNumber(moduleStats.rollingWindow, requiredConsecutiveSessions)));
  const requiredMasteredItems = Math.max(1, Math.floor(asNumber(moduleStats.requiredMasteredItems, Math.min(3, items.length || 3))));

  const masteredItems = items.filter((item) => isMasteredItem(item)).length;
  const masteryRate = items.length ? Number(((masteredItems / items.length) * 100).toFixed(2)) : 0;
  const recentSessions = sessions.slice(-rollingWindow);
  const recentAccuracy = averageAccuracy(recentSessions);
  const trailingPassingSessions = countTrailingPassingSessions(sessions, masteryThreshold);
  const passingSessions = sessions.filter((entry) => clamp(entry.accuracy, 0, 100, 0) >= masteryThreshold).length;

  const passed = items.length > 0
    && masteredItems >= requiredMasteredItems
    && recentAccuracy >= masteryThreshold
    && trailingPassingSessions >= requiredConsecutiveSessions;

  return {
    moduleId: moduleStats.moduleId || null,
    title: moduleStats.title || null,
    passed,
    masteryRate: Number(masteryRate.toFixed(2)),
    masteredItems,
    totalItems: items.length,
    requiredMasteredItems,
    recentAccuracy,
    masteryThreshold,
    requiredConsecutiveSessions,
    trailingPassingSessions,
    passingSessions,
    totalSessions: sessions.length,
    recentSessions: recentSessions.length,
  };
}

function collectCompletedModuleIds(userProgress = {}) {
  const sources = [
    userProgress.completedModules,
    userProgress.masteredModules,
    userProgress.unlockedModules,
    userProgress.moduleIds,
    userProgress.courseProgress?.completedModules,
    userProgress.courseProgress?.masteredModules,
    userProgress.progress?.completedModules,
  ];

  const ids = new Set();
  sources.forEach((source) => {
    if (!Array.isArray(source)) return;
    source.forEach((entry) => {
      if (!entry) return;
      if (typeof entry === 'string' || typeof entry === 'number') {
        const value = String(entry).trim();
        if (value) ids.add(value);
        return;
      }
      const candidate = String(entry.moduleId || entry.id || entry._id || entry.lessonId || entry.chapterId || '').trim();
      if (candidate && (entry.unlocked === true || entry.completed === true || entry.mastered === true || entry.passed === true || entry.status === 'completed' || entry.status === 'mastered')) {
        ids.add(candidate);
      }
    });
  });

  return Array.from(ids);
}

function normalizePrerequisiteModuleIds(moduleStats = {}) {
  const raw = [
    moduleStats.prerequisiteModuleId,
    moduleStats.previousModuleId,
    ...(Array.isArray(moduleStats.prerequisiteModuleIds) ? moduleStats.prerequisiteModuleIds : []),
    ...(Array.isArray(moduleStats.prerequisites)
      ? moduleStats.prerequisites.map((entry) => (typeof entry === 'string' || typeof entry === 'number' ? entry : entry?.moduleId || entry?.id || entry?._id))
      : []),
  ];

  return Array.from(new Set(raw.map((value) => String(value || '').trim()).filter(Boolean)));
}

function canUnlockNextModule(userProgress = {}, moduleStats = {}) {
  const moduleId = String(moduleStats.moduleId || moduleStats.id || moduleStats._id || '').trim();
  const moduleMastery = computeModuleMastery(moduleStats);
  const completedModuleIds = collectCompletedModuleIds(userProgress);
  const prerequisiteModuleIds = normalizePrerequisiteModuleIds(moduleStats);
  const missingPrerequisites = prerequisiteModuleIds.filter((id) => !completedModuleIds.includes(id));
  const prerequisitesMet = missingPrerequisites.length === 0;

  if (!moduleId) {
    return {
      unlocked: false,
      reason: 'Module id is required to evaluate unlocks.',
      moduleMastery,
      prerequisitesMet: false,
      missingPrerequisites,
      completedModuleIds,
    };
  }

  if (!prerequisitesMet) {
    return {
      unlocked: false,
      reason: 'Complete the prerequisite module before unlocking the next one.',
      moduleMastery,
      prerequisitesMet,
      missingPrerequisites,
      completedModuleIds,
    };
  }

  if (!moduleMastery.passed) {
    return {
      unlocked: false,
      reason: `Module mastery is not yet strong enough. Need ${moduleMastery.requiredMasteredItems} mastered item(s), ${moduleMastery.requiredConsecutiveSessions} passing session(s), and ${moduleMastery.masteryThreshold}% recent accuracy.`,
      moduleMastery,
      prerequisitesMet,
      missingPrerequisites,
      completedModuleIds,
    };
  }

  return {
    unlocked: true,
    reason: 'Module mastery is complete and all prerequisites are satisfied.',
    moduleMastery,
    prerequisitesMet,
    missingPrerequisites,
    completedModuleIds,
  };
}

module.exports = {
  updateMasteryStatus,
  computeModuleMastery,
  canUnlockNextModule,
};