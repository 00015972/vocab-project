function asNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(n, 0);
}

function asBoundedNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeCorrectness(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'correct', 'correctly'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'incorrect', 'wrong'].includes(trimmed)) return false;
  }
  return false;
}

function isKnownCorrectness(value) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return false;
    return ['true', '1', 'yes', 'y', 'correct', 'correctly', 'false', '0', 'no', 'n', 'incorrect', 'wrong'].includes(trimmed);
  }
  return false;
}

function classifyAttemptBehavior(latencyMs, correctness, baselineLatency) {
  const latency = asNonNegativeNumber(latencyMs, 0);
  const baseline = Math.max(asNonNegativeNumber(baselineLatency, 2200), 400);
  const isCorrect = normalizeCorrectness(correctness);

  if (!isCorrect && latency > 0 && latency <= Math.max(700, baseline * 0.45)) {
    return 'fast_guess_wrong';
  }
  if (!isCorrect && latency >= baseline * 1.45) {
    return 'slow_struggle_wrong';
  }
  if (isCorrect && latency <= Math.max(900, baseline * 0.7)) {
    return 'confident_correct';
  }
  if (isCorrect && latency >= baseline * 1.35) {
    return 'slow_but_correct';
  }
  return isCorrect ? 'steady_correct' : 'steady_wrong';
}

function computeConfidenceScore(attempt) {
  const behavior = String(attempt?.behavior || 'steady_wrong');
  const accuracy = asBoundedNumber(attempt?.accuracy, 0, 100, 0) / 100;
  const latencyRatio = asBoundedNumber(attempt?.latencyRatio, 0.15, 3, 1);
  let score = accuracy * 0.6;

  if (behavior === 'confident_correct') score += 0.32;
  else if (behavior === 'steady_correct') score += 0.22;
  else if (behavior === 'slow_but_correct') score += 0.08;
  else if (behavior === 'fast_guess_wrong') score -= 0.28;
  else if (behavior === 'slow_struggle_wrong') score -= 0.24;
  else score -= 0.12;

  if (latencyRatio > 1.6 && behavior.includes('wrong')) score -= 0.08;
  if (latencyRatio < 0.55 && behavior.includes('wrong')) score -= 0.08;

  return Number(asBoundedNumber(score, 0, 1, 0.5).toFixed(4));
}

function createAdaptiveProfileDefaults() {
  return {
    targetLevel: 'A1',
    abilityScore: 0,
    difficultyBand: { min: 1, max: 2 },
    diagnostic: {
      completedAt: null,
      attempts: 0,
      correct: 0,
      accuracy: 0,
      averageLatencyMs: 0,
      sessionToken: null,
    },
    behaviorSignals: {
      baselineLatencyMs: 2200,
      confidenceScore: 0.6,
      fastGuessRate: 0,
      slowStruggleRate: 0,
      recentBehaviors: [],
      updatedAt: null,
    },
    masteryGates: {
      flashcards: { unlocked: true, reason: 'Available by default.', requiredSubSkills: [], subSkills: {}, lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
      matching: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', requiredSubSkills: [], subSkills: {}, lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
      quiz: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', requiredSubSkills: [], subSkills: {}, lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
      spelling: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', requiredSubSkills: [], subSkills: {}, lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
    },
    remediation: {
      active: false,
      reason: '',
      focusModes: [],
      recommendedWordIds: [],
      updatedAt: null,
    },
  };
}

function updateBehaviorSignals(userState, signals) {
  if (!userState || typeof userState !== 'object') return null;

  if (!userState.adaptiveProfile || typeof userState.adaptiveProfile !== 'object') {
    userState.adaptiveProfile = createAdaptiveProfileDefaults();
  }

  const adaptive = userState.adaptiveProfile && typeof userState.adaptiveProfile === 'object'
    ? userState.adaptiveProfile
    : {};
  const existing = adaptive.behaviorSignals && typeof adaptive.behaviorSignals === 'object'
    ? adaptive.behaviorSignals
    : {
        baselineLatencyMs: 2200,
        confidenceScore: 0.6,
        fastGuessRate: 0,
        slowStruggleRate: 0,
        recentBehaviors: [],
        updatedAt: null,
      };

  const attempts = Array.isArray(signals?.attempts)
    ? signals.attempts.filter((attempt) => isKnownCorrectness(attempt?.correctness))
    : [];
  if (!attempts.length) {
    userState.adaptiveProfile.behaviorSignals = existing;
    return existing;
  }

  const baselineCandidates = attempts
    .map((item) => asNonNegativeNumber(item?.latencyMs, NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgLatency = baselineCandidates.length
    ? baselineCandidates.reduce((sum, value) => sum + value, 0) / baselineCandidates.length
    : asNonNegativeNumber(existing.baselineLatencyMs, 2200);
  const nextBaseline = Math.max(400, Math.round(((asNonNegativeNumber(existing.baselineLatencyMs, 2200) * 0.7) + (avgLatency * 0.3))));

  let fastGuessHits = 0;
  let slowStruggleHits = 0;
  const behaviors = [];
  const confidenceValues = [];

  attempts.forEach((attempt) => {
    const normalizedCorrectness = normalizeCorrectness(attempt?.correctness);
    const behavior = classifyAttemptBehavior(attempt?.latencyMs, normalizedCorrectness, nextBaseline || existing.baselineLatencyMs);
    const latencyRatio = nextBaseline ? asNonNegativeNumber(attempt?.latencyMs, nextBaseline) / nextBaseline : 1;
    const confidence = computeConfidenceScore({
      behavior,
      accuracy: normalizedCorrectness ? 100 : 0,
      latencyRatio,
    });

    if (behavior === 'fast_guess_wrong') fastGuessHits += 1;
    if (behavior === 'slow_struggle_wrong') slowStruggleHits += 1;
    behaviors.push(behavior);
    confidenceValues.push(confidence);
  });

  const avgConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : asBoundedNumber(existing.confidenceScore, 0, 1, 0.6);

  const nextSignals = {
    baselineLatencyMs: nextBaseline,
    confidenceScore: Number((((asBoundedNumber(existing.confidenceScore, 0, 1, 0.6) * 0.55) + (avgConfidence * 0.45)).toFixed(4))),
    fastGuessRate: Number((((asBoundedNumber(existing.fastGuessRate, 0, 1, 0) * 0.6) + ((fastGuessHits / attempts.length) * 0.4)).toFixed(4))),
    slowStruggleRate: Number((((asBoundedNumber(existing.slowStruggleRate, 0, 1, 0) * 0.6) + ((slowStruggleHits / attempts.length) * 0.4)).toFixed(4))),
    recentBehaviors: [...(Array.isArray(existing.recentBehaviors) ? existing.recentBehaviors : []), ...behaviors].slice(-12),
    updatedAt: new Date().toISOString(),
  };

  userState.adaptiveProfile.behaviorSignals = nextSignals;
  return nextSignals;
}

module.exports = {
  asNonNegativeNumber,
  asBoundedNumber,
  normalizeCorrectness,
  isKnownCorrectness,
  classifyAttemptBehavior,
  computeConfidenceScore,
  updateBehaviorSignals,
};
