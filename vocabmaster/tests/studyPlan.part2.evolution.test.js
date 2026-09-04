const assert = require('assert');
const progressRouter = require('../src/routes/progress');

const {
  normalizeProgressSnapshot,
  buildDailyPlanFromProfile,
  applyMasteryGates,
  applyRemediation,
  finalizeExerciseMix,
  ensureStudyPlanPersonalizationContract,
  updateBehaviorSignals,
  updateAdaptiveProfileFromSession,
} = progressRouter.__internals;

function buildPlanFromProgress(progress, words = []) {
  const snapshot = normalizeProgressSnapshot(progress, progress.userId);
  const plan = buildDailyPlanFromProfile(snapshot, { minutes: 25, wordCount: 14, hearts: 4 });
  plan.snapshot = snapshot;
  plan.dueReviews = words.filter((w) => {
    const nextReviewAt = w && w.nextReviewAt ? new Date(w.nextReviewAt) : null;
    return nextReviewAt && Number.isFinite(nextReviewAt.getTime()) && nextReviewAt.getTime() <= Date.now();
  }).length;

  applyMasteryGates(plan);
  applyRemediation(plan, { words });
  finalizeExerciseMix(plan, { lowHeartsBoostMode: 'flashcards' });
  ensureStudyPlanPersonalizationContract(plan);
  return plan;
}

function applySessionOutcome(progress, { accuracy, xpEarned, wordsCompleted, attempts }) {
  const previousLessonsCompleted = Number(progress.lessonsCompleted || 0);
  const previousAccuracy = Number(progress.accuracy || 0);

  progress.lessonsCompleted = previousLessonsCompleted + 1;
  progress.accuracy = previousLessonsCompleted === 0
    ? accuracy
    : Number((((previousAccuracy * previousLessonsCompleted) + accuracy) / progress.lessonsCompleted).toFixed(2));

  updateBehaviorSignals(progress, { attempts });
  updateAdaptiveProfileFromSession(progress, {
    accuracy,
    xpEarned,
    wordsCompleted,
    attempts,
  });
}

function run() {
  const progress = {
    userId: 'part2-user',
    totalXP: 300,
    streak: 2,
    longestStreak: 2,
    lessonsCompleted: 2,
    wordsLearned: 20,
    accuracy: 78,
    totalStudyTime: 300,
    adaptiveProfile: {
      targetLevel: 'A2',
      abilityScore: 58,
      difficultyBand: { min: 2, max: 3 },
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
    },
  };

  const words = [
    { word: 'alpha', nextReviewAt: new Date(Date.now() - 3600000).toISOString(), difficulty: 2, adaptiveMetrics: { attempts: 5, correct: 4, lastAttemptAt: new Date().toISOString() }, tags: ['core'] },
    { word: 'beta', nextReviewAt: new Date(Date.now() + 3600000).toISOString(), difficulty: 3, adaptiveMetrics: { attempts: 4, correct: 3, lastAttemptAt: new Date().toISOString() }, tags: ['core'] },
    { word: 'gamma', nextReviewAt: new Date(Date.now() - 7200000).toISOString(), difficulty: 2, adaptiveMetrics: { attempts: 3, correct: 2, lastAttemptAt: new Date().toISOString() }, tags: ['core'] },
  ];

  const baselinePlan = buildPlanFromProgress(progress, words);

  applySessionOutcome(progress, {
    accuracy: 92,
    xpEarned: 260,
    wordsCompleted: 10,
    attempts: [
      { correctness: true, latencyMs: 1400 },
      { correctness: true, latencyMs: 1500 },
      { correctness: true, latencyMs: 1600 },
      { correctness: true, latencyMs: 1700 },
      { correctness: true, latencyMs: 1550 },
    ],
  });
  const strongPlan = buildPlanFromProgress(progress, words);

  applySessionOutcome(progress, {
    accuracy: 0,
    xpEarned: 40,
    wordsCompleted: 8,
    attempts: [
      { correctness: false, latencyMs: 350 },
      { correctness: false, latencyMs: 400 },
      { correctness: false, latencyMs: 5200 },
      { correctness: false, latencyMs: 5400 },
      { correctness: true, latencyMs: 3600 },
    ],
  });
  const weakPlan = buildPlanFromProgress(progress, words);

  assert.ok(strongPlan.abilityScore >= baselinePlan.abilityScore, 'ability should improve after a strong session');
  assert.ok(weakPlan.abilityScore <= strongPlan.abilityScore, 'ability should not improve after a weak session');

  assert.ok(strongPlan.personalization.dueReviews >= 0, 'due reviews should be included in personalization');
  assert.ok(typeof weakPlan.personalization.remediationStatus === 'string', 'remediation status should be included in personalization');

  assert.ok(weakPlan.targetWordCount <= strongPlan.targetWordCount, 'weak outcomes should not increase next target word count');
  assert.ok(weakPlan.remediation.active, 'weak outcomes should activate remediation');
  assert.ok(strongPlan.unlockedModes.length >= weakPlan.unlockedModes.length, 'weaker outcomes should not unlock more modes than strong outcomes');
  assert.ok(
    weakPlan.behaviorSignals.fastGuessRate > strongPlan.behaviorSignals.fastGuessRate
    || weakPlan.behaviorSignals.slowStruggleRate > strongPlan.behaviorSignals.slowStruggleRate,
    'weak outcomes should increase risky behavior signals'
  );
  assert.notStrictEqual(
    strongPlan.personalization.remediationStatus,
    weakPlan.personalization.remediationStatus,
    'personalization status should change after weak outcomes'
  );

  assert.ok(progress.adaptiveProfile.diagnostic.attempts >= 10, 'diagnostic attempts should be accumulated from session attempts');
  assert.ok(progress.adaptiveProfile.diagnostic.correct >= 0, 'diagnostic correct counter should be maintained');
  assert.ok(progress.adaptiveProfile.diagnostic.accuracy >= 0 && progress.adaptiveProfile.diagnostic.accuracy <= 100, 'diagnostic accuracy should be bounded');

  console.log('study plan part2 evolution tests passed');
}

run();
