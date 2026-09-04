const test = require('node:test');
const assert = require('node:assert/strict');

const progressRouter = require('../src/routes/progress');

const {
  normalizeProgressSnapshot,
  buildDailyPlanFromProfile,
  applyMasteryGates,
  applyRemediation,
} = progressRouter.__internals;

function makeProgress(overrides = {}) {
  return {
    userId: 'part2-user',
    accuracy: 80,
    lessonsCompleted: 5,
    adaptiveProfile: {
      targetLevel: 'A2',
      abilityScore: 62,
      difficultyBand: { min: 2, max: 3 },
      diagnostic: {
        completedAt: null,
        attempts: 6,
        correct: 4,
        accuracy: 66.67,
        averageLatencyMs: 2100,
      },
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.62,
        fastGuessRate: 0.08,
        slowStruggleRate: 0.1,
        recentBehaviors: ['steady_correct', 'steady_correct', 'steady_wrong', 'steady_correct'],
      },
      ...overrides.adaptiveProfile,
    },
    ...overrides,
  };
}

function buildPlan(progressInput, prefs = { minutes: 20, wordCount: 12, hearts: 5 }) {
  const snapshot = normalizeProgressSnapshot(progressInput, progressInput.userId || 'part2-user');
  const plan = buildDailyPlanFromProfile(snapshot, prefs);
  plan.snapshot = snapshot;
  plan.dueReviews = 0;
  return plan;
}

test('Part2: mastery gates block in weak state and unlock in strong state with transitions tracked', () => {
  const weakProgress = makeProgress({
    accuracy: 55,
    lessonsCompleted: 2,
    adaptiveProfile: {
      targetLevel: 'A1',
      abilityScore: 42,
      diagnostic: { attempts: 1, correct: 0, accuracy: 0, averageLatencyMs: 2600 },
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.45,
        fastGuessRate: 0.24,
        slowStruggleRate: 0.23,
        recentBehaviors: ['fast_guess_wrong', 'slow_struggle_wrong'],
      },
    },
  });

  const weakPlan = buildPlan(weakProgress, { minutes: 20, wordCount: 12, hearts: 5 });
  applyMasteryGates(weakPlan);

  assert.equal(weakPlan.masteryGates.flashcards.unlocked, true);
  assert.equal(weakPlan.masteryGates.matching.unlocked, false);
  assert.equal(weakPlan.masteryGates.quiz.unlocked, false);
  assert.equal(weakPlan.masteryGates.spelling.unlocked, false);
  assert.equal(weakPlan.unlockedModes.includes('flashcards'), true);

  const strongProgress = makeProgress({
    accuracy: 88,
    lessonsCompleted: 6,
    adaptiveProfile: {
      targetLevel: 'B1',
      abilityScore: 76,
      diagnostic: { attempts: 10, correct: 8, accuracy: 80, averageLatencyMs: 1800 },
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.74,
        fastGuessRate: 0.05,
        slowStruggleRate: 0.08,
        recentBehaviors: ['steady_correct', 'steady_correct', 'steady_correct', 'steady_correct'],
      },
      masteryGates: weakPlan.masteryGates,
    },
  });

  const strongPlan = buildPlan(strongProgress, { minutes: 20, wordCount: 12, hearts: 5 });
  applyMasteryGates(strongPlan);

  assert.equal(strongPlan.masteryGates.matching.unlocked, true);
  assert.equal(strongPlan.masteryGates.quiz.unlocked, true);
  assert.equal(strongPlan.masteryGates.spelling.unlocked, true);
  assert.equal(strongPlan.unlockedModes.includes('quiz'), true);

  assert.equal(strongPlan.masteryGates.quiz.transitionCount >= 1, true);
  assert.equal(Array.isArray(strongPlan.masteryGates.quiz.transitionHistory), true);
  assert.equal(strongPlan.masteryGates.quiz.transitionHistory.length >= 1, true);
  const lastTransition = strongPlan.masteryGates.quiz.transitionHistory[strongPlan.masteryGates.quiz.transitionHistory.length - 1];
  assert.equal(lastTransition.to, 'unlocked');
});

test('Part2: remediation triggers when sub-topic accuracy drops below threshold', () => {
  const progress = makeProgress({
    accuracy: 82,
    lessonsCompleted: 5,
    adaptiveProfile: {
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.66,
        fastGuessRate: 0.05,
        slowStruggleRate: 0.08,
        recentBehaviors: ['steady_correct', 'steady_correct', 'steady_correct', 'steady_correct'],
      },
    },
  });

  const words = [
    {
      word: 'abate',
      tags: ['verbs'],
      adaptiveMetrics: { attempts: 6, correct: 2, lastAttemptAt: '2026-08-06T09:00:00.000Z' },
      timesReviewed: 6,
      timesCorrect: 2,
    },
    {
      word: 'attenuate',
      tags: ['verbs'],
      adaptiveMetrics: { attempts: 6, correct: 2, lastAttemptAt: '2026-08-06T08:00:00.000Z' },
      timesReviewed: 6,
      timesCorrect: 2,
    },
  ];

  const plan = buildPlan(progress, { minutes: 20, wordCount: 12, hearts: 5 });
  applyRemediation(plan, { words });

  assert.equal(plan.remediation.active, true);
  assert.equal(plan.remediation.subtopicStruggle, true);
  assert.equal(plan.remediation.status, 'active');
  assert.equal(plan.remediation.subtopicSignals.primary.subtopic, 'verbs');
  assert.equal(plan.remediation.subtopicSignals.primary.accuracyPct < 50, true);
});

test('Part2: remediation stays clear at threshold boundary when no other risk signal exists', () => {
  const progress = makeProgress({
    accuracy: 84,
    lessonsCompleted: 6,
    adaptiveProfile: {
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.7,
        fastGuessRate: 0.04,
        slowStruggleRate: 0.06,
        recentBehaviors: ['steady_correct', 'steady_correct', 'steady_correct', 'steady_correct'],
      },
    },
  });

  const words = [
    {
      word: 'clarify',
      tags: ['verbs'],
      adaptiveMetrics: { attempts: 4, correct: 2, lastAttemptAt: '2026-08-06T09:00:00.000Z' },
      timesReviewed: 4,
      timesCorrect: 2,
    },
  ];

  const plan = buildPlan(progress, { minutes: 20, wordCount: 12, hearts: 5 });
  applyRemediation(plan, { words });

  assert.equal(plan.remediation.subtopicStruggle, false);
  assert.equal(plan.remediation.active, false);
  assert.equal(plan.remediation.status, 'clear');
});
