const assert = require('assert');
const progressRouter = require('../src/routes/progress');

const {
  normalizeProgressSnapshot,
  buildDailyPlanFromProfile,
  applyMasteryGates,
  applyRemediation,
  finalizeExerciseMix,
  ensureStudyPlanPersonalizationContract,
} = progressRouter.__internals;

function run() {
  const userId = 'part1-user';
  const rawProgress = {
    userId,
    totalXP: 980,
    accuracy: 61,
    streak: 3,
    lessonsCompleted: 5,
    adaptiveProfile: {
      targetLevel: 'A2',
      abilityScore: 64,
      diagnostic: {
        attempts: 12,
        correct: 8,
        accuracy: 66.67,
        averageLatencyMs: 2100,
      },
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.56,
        fastGuessRate: 0.14,
        slowStruggleRate: 0.18,
        recentBehaviors: ['steady_correct', 'steady_wrong'],
      },
    },
  };

  const snapshot = normalizeProgressSnapshot(rawProgress, userId);
  const plan = buildDailyPlanFromProfile(snapshot, { minutes: 25, wordCount: 14, hearts: 4 });
  plan.snapshot = snapshot;
  plan.dueReviews = 7;

  applyMasteryGates(plan);
  applyRemediation(plan, { words: [] });
  finalizeExerciseMix(plan, { lowHeartsBoostMode: 'flashcards' });
  ensureStudyPlanPersonalizationContract(plan);

  assert.strictEqual(typeof plan.diagnosticLevel, 'string');
  assert.ok(plan.diagnosticLevel.length > 0, 'diagnosticLevel should be present');

  assert.strictEqual(typeof plan.abilityScore, 'number');
  assert.ok(plan.abilityScore >= 0 && plan.abilityScore <= 100, 'abilityScore should be bounded 0..100');

  assert.strictEqual(typeof plan.masteryGates, 'object');
  assert.ok(plan.masteryGates.flashcards, 'masteryGates.flashcards should exist');

  assert.strictEqual(typeof plan.dueReviews, 'number');
  assert.ok(plan.dueReviews >= 0, 'dueReviews should be non-negative');

  assert.strictEqual(typeof plan.remediation, 'object');
  assert.ok(['active', 'clear'].includes(plan.remediation.status), 'remediation.status should be active or clear');

  assert.strictEqual(typeof plan.personalization, 'object');
  assert.strictEqual(plan.personalization.diagnosticLevel, plan.diagnosticLevel);
  assert.strictEqual(plan.personalization.abilityScore, plan.abilityScore);
  assert.strictEqual(plan.personalization.dueReviews, plan.dueReviews);
  assert.strictEqual(plan.personalization.remediationStatus, plan.remediation.status);

  assert.ok(Array.isArray(plan.exerciseMix) && plan.exerciseMix.length > 0, 'exercise mix should be finalized');

  console.log('study plan part1 contract tests passed');
}

run();
