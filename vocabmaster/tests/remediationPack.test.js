const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRemediationPack } = require('../src/services/remediationPack');
const progressRouter = require('../src/routes/progress');

const { applyRemediation } = progressRouter.__internals;

function mkWord(id, props = {}) {
  return {
    _id: id,
    word: `w-${id}`,
    definition: `def-${id}`,
    tags: [],
    domain: 'general',
    difficulty: 3,
    learningStatus: 'in_progress',
    adaptiveMetrics: { attempts: 0, correct: 0, itemDifficulty: 50 },
    ...props,
  };
}

test('buildRemediationPack selects simpler focused words for struggling subtopic', () => {
  const words = [
    mkWord('v1', { tags: ['verbs'], difficulty: 1, adaptiveMetrics: { attempts: 6, correct: 1, itemDifficulty: 20 } }),
    mkWord('v2', { tags: ['verbs'], difficulty: 2, adaptiveMetrics: { attempts: 8, correct: 2, itemDifficulty: 30 } }),
    mkWord('v3', { tags: ['verbs'], difficulty: 4, adaptiveMetrics: { attempts: 5, correct: 4, itemDifficulty: 70 } }),
    mkWord('n1', { tags: ['nouns'], difficulty: 2, adaptiveMetrics: { attempts: 8, correct: 8, itemDifficulty: 30 } }),
  ];

  const pack = buildRemediationPack('verbs', 2, { words, maxItems: 2 });

  assert.equal(pack.active, true);
  assert.equal(pack.subtopic, 'verbs');
  assert.equal(pack.totalSelected, 2);
  assert.equal(pack.words.length, 2);
  assert.equal(pack.words.every((item) => item.subtopic === 'verbs'), true);
  assert.equal(pack.words[0].difficulty <= 2.5, true);
  assert.equal(Array.isArray(pack.miniLesson.steps), true);
  assert.equal(pack.miniLesson.steps.length, 3);
});

test('buildRemediationPack avoids mastered items and handles empty candidate set', () => {
  const words = [
    mkWord('m1', { tags: ['phrases'], learningStatus: 'mastered', adaptiveMetrics: { attempts: 10, correct: 10, itemDifficulty: 85 } }),
  ];

  const pack = buildRemediationPack('phrases', 1, { words, maxItems: 4 });

  assert.equal(pack.active, false);
  assert.equal(pack.totalSelected, 0);
  assert.equal(pack.words.length, 0);
});

test('applyRemediation attaches remediationPack when subtopic struggle is active', () => {
  const plan = {
    snapshot: {
      accuracy: 74,
      adaptiveProfile: {
        difficultyBand: { min: 2, max: 3 },
      },
    },
    heartState: { lowHearts: false },
    behaviorSignals: { slowStruggleRate: 0.05, fastGuessRate: 0.05 },
  };

  const words = [
    mkWord('a1', { tags: ['verbs'], domain: 'grammar', difficulty: 1, adaptiveMetrics: { attempts: 7, correct: 1, itemDifficulty: 20, lastAttemptAt: '2026-08-06T10:00:00.000Z' }, timesReviewed: 7, timesCorrect: 1 }),
    mkWord('a2', { tags: ['verbs'], domain: 'grammar', difficulty: 2, adaptiveMetrics: { attempts: 6, correct: 2, itemDifficulty: 25, lastAttemptAt: '2026-08-06T09:55:00.000Z' }, timesReviewed: 6, timesCorrect: 2 }),
    mkWord('n1', { tags: ['nouns'], domain: 'academic', difficulty: 2, adaptiveMetrics: { attempts: 6, correct: 6, itemDifficulty: 40, lastAttemptAt: '2026-08-06T09:50:00.000Z' }, timesReviewed: 6, timesCorrect: 6 }),
  ];

  const result = applyRemediation(plan, { words });

  assert.equal(result.remediation.active, true);
  assert.equal(result.remediation.subtopicStruggle, true);
  assert.ok(result.remediation.remediationPack);
  assert.equal(result.remediation.remediationPack.active, true);
  assert.equal(['verbs', 'grammar'].includes(result.remediation.remediationPack.subtopic), true);
  assert.equal(result.remediation.remediationPack.words.length > 0, true);
});
