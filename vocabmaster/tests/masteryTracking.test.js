const test = require('node:test');
const assert = require('node:assert/strict');
const { updateMasteryStatus, computeModuleMastery, canUnlockNextModule } = require('../src/services/masteryTracking');

test('updateMasteryStatus stays locked until mastery criteria are met', () => {
  const word = {
    learningStatus: 'locked',
    adaptiveMetrics: {
      masteryHistory: [
        { sessionId: 's1', sessionAt: '2026-01-01T10:00:00.000Z', accuracy: 100, correctCount: 1, totalCount: 1 },
        { sessionId: 's2', sessionAt: '2026-01-03T10:00:00.000Z', accuracy: 70, correctCount: 7, totalCount: 10 },
      ],
    },
    masterySession: {
      sessionId: 's3',
      sessionAt: '2026-01-05T10:00:00.000Z',
      accuracy: 100,
      correctCount: 1,
      totalCount: 1,
      mode: 'study',
      responseTimeMs: 900,
    },
  };

  const result = updateMasteryStatus(word);

  assert.equal(result.mastered, false);
  assert.equal(result.masteryStatus, 'in_progress');
  assert.equal(word.learningStatus, 'in_progress');
  assert.equal(word.adaptiveMetrics.masterySessionCount, 3);
  assert.equal(word.adaptiveMetrics.masteryQualifyingSessions, 2);
  assert.equal(word.adaptiveMetrics.masteryRecentAccuracy, 90);
});

test('updateMasteryStatus marks a word mastered after three passing sessions across distinct days', () => {
  const word = {
    learningStatus: 'in_progress',
    adaptiveMetrics: {
      masteryHistory: [
        { sessionId: 's1', sessionAt: '2026-01-01T10:00:00.000Z', accuracy: 100, correctCount: 1, totalCount: 1 },
        { sessionId: 's2', sessionAt: '2026-01-03T10:00:00.000Z', accuracy: 90, correctCount: 9, totalCount: 10 },
      ],
    },
    masterySession: {
      sessionId: 's3',
      sessionAt: '2026-01-06T10:00:00.000Z',
      accuracy: 100,
      correctCount: 1,
      totalCount: 1,
      mode: 'study',
      responseTimeMs: 700,
    },
  };

  const result = updateMasteryStatus(word);

  assert.equal(result.mastered, true);
  assert.equal(result.masteryStatus, 'mastered');
  assert.equal(word.learningStatus, 'mastered');
  assert.ok(word.adaptiveMetrics.masteredAt);
  assert.equal(word.adaptiveMetrics.masteryDistinctDays, 3);
  assert.equal(word.adaptiveMetrics.masterySpreadDays >= 5, true);
});

test('computeModuleMastery uses mastered items and recent session accuracy', () => {
  const result = computeModuleMastery({
    moduleId: 'm1',
    items: [
      { adaptiveMetrics: { masteredAt: '2026-01-01T00:00:00.000Z' } },
      { masteryStatus: 'mastered' },
      { learningStatus: 'in_progress' },
    ],
    sessionHistory: [
      { sessionId: 'a', sessionAt: '2026-01-01T00:00:00.000Z', accuracy: 100 },
      { sessionId: 'b', sessionAt: '2026-01-02T00:00:00.000Z', accuracy: 90 },
      { sessionId: 'c', sessionAt: '2026-01-03T00:00:00.000Z', accuracy: 95 },
    ],
    requiredMasteredItems: 2,
    requiredConsecutiveSessions: 3,
  });

  assert.equal(result.passed, true);
  assert.equal(result.masteredItems, 2);
  assert.equal(result.totalItems, 3);
  assert.equal(result.recentAccuracy, 95);
});

test('canUnlockNextModule blocks unlock when prerequisites are missing', () => {
  const result = canUnlockNextModule(
    { completedModules: ['module-1'] },
    {
      moduleId: 'module-2',
      prerequisiteModuleIds: ['module-1', 'module-1b'],
      items: [
        { adaptiveMetrics: { masteredAt: '2026-01-01T00:00:00.000Z' } },
        { masteryStatus: 'mastered' },
        { adaptiveMetrics: { masteredAt: '2026-01-02T00:00:00.000Z' } },
      ],
      sessionHistory: [
        { sessionId: 'a', sessionAt: '2026-01-01T00:00:00.000Z', accuracy: 100 },
        { sessionId: 'b', sessionAt: '2026-01-02T00:00:00.000Z', accuracy: 90 },
        { sessionId: 'c', sessionAt: '2026-01-03T00:00:00.000Z', accuracy: 95 },
      ],
      requiredMasteredItems: 2,
      requiredConsecutiveSessions: 3,
    }
  );

  assert.equal(result.unlocked, false);
  assert.deepEqual(result.missingPrerequisites, ['module-1b']);
  assert.equal(result.prerequisitesMet, false);
});

test('canUnlockNextModule unlocks when mastery and prerequisites are satisfied', () => {
  const result = canUnlockNextModule(
    { completedModules: ['module-1', 'module-1b'] },
    {
      moduleId: 'module-2',
      prerequisiteModuleIds: ['module-1', 'module-1b'],
      items: [
        { adaptiveMetrics: { masteredAt: '2026-01-01T00:00:00.000Z' } },
        { masteryStatus: 'mastered' },
        { adaptiveMetrics: { masteredAt: '2026-01-02T00:00:00.000Z' } },
      ],
      sessionHistory: [
        { sessionId: 'a', sessionAt: '2026-01-01T00:00:00.000Z', accuracy: 100 },
        { sessionId: 'b', sessionAt: '2026-01-02T00:00:00.000Z', accuracy: 90 },
        { sessionId: 'c', sessionAt: '2026-01-03T00:00:00.000Z', accuracy: 95 },
      ],
      requiredMasteredItems: 2,
      requiredConsecutiveSessions: 3,
    }
  );

  assert.equal(result.unlocked, true);
  assert.equal(result.prerequisitesMet, true);
  assert.equal(result.moduleMastery.passed, true);
});
