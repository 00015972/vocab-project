const test = require('node:test');
const assert = require('node:assert/strict');

const wordsRoute = require('../src/routes/words');
const studyRoute = require('../src/routes/study');
const progressRoute = require('../src/routes/progress');

const {
  normalizeDifficulty,
  normalizeDomain,
  normalizeTargetBand,
  normalizeStatus,
} = wordsRoute;

const {
  scoreDiagnostic,
  assignTargetLevel,
} = studyRoute.__internals;

const {
  injectRemediationIntoPlan,
} = progressRoute.__internals;

test('Task1 contract: word metadata normalization functions enforce expected bounds and enums', () => {
  assert.equal(normalizeDifficulty(7), 5);
  assert.equal(normalizeDifficulty(-2), 1);
  assert.equal(normalizeDifficulty('x'), 3);

  assert.equal(normalizeDomain('  Academic Writing  '), 'academic writing');
  assert.equal(normalizeDomain(''), 'general');

  assert.equal(normalizeTargetBand('700+'), '700+');
  assert.equal(normalizeTargetBand('invalid'), '500-600');

  assert.equal(normalizeStatus('Mastered'), 'mastered');
  assert.equal(normalizeStatus('In_Progress'), 'in_progress');
  assert.equal(normalizeStatus('unknown'), 'locked');
});

test('Task2 contract: scoreDiagnostic computes attempts, accuracy, and latency from response payload', () => {
  const questions = [
    {
      questionId: 'dq_1',
      wordId: 'w1',
      answer: 'lucid',
      meta: { difficulty: 2 },
    },
    {
      questionId: 'dq_2',
      wordId: 'w2',
      answer: 'opaque',
      meta: { difficulty: 3 },
    },
  ];

  const responses = [
    { questionId: 'dq_1', answer: 'lucid', responseTimeMs: 1000 },
    { questionId: 'dq_2', answer: 'wrong', responseTimeMs: 3000 },
    { questionId: 'dq_missing', answer: 'ignored', responseTimeMs: 10 },
  ];

  const scored = scoreDiagnostic(responses, questions);

  assert.equal(scored.attempts, 2);
  assert.equal(scored.correct, 1);
  assert.equal(scored.accuracy, 50);
  assert.equal(scored.averageLatencyMs, 2000);
  assert.equal(scored.scoredResponses.length, 2);
});

test('Task2 contract: assignTargetLevel degrades for low accuracy and upgrades for strong accuracy', () => {
  const low = assignTargetLevel(40, 2000);
  const high = assignTargetLevel(92, 1800);

  assert.equal(low.level, 'A1');
  assert.ok(['B2', 'C1', 'C2'].includes(high.level));
});

test('Task7 contract: injectRemediationIntoPlan attaches pack and synchronizes active status', () => {
  const plan = {
    remediation: {
      active: false,
      status: 'clear',
      reason: '',
    },
  };

  const pack = {
    active: true,
    reason: 'Prepared targeted support set.',
    words: [{ wordId: 'w1', word: 'lucid' }],
    totalSelected: 1,
  };

  const updated = injectRemediationIntoPlan(plan, pack, { syncActive: true });

  assert.equal(updated.remediation.active, true);
  assert.equal(updated.remediation.status, 'active');
  assert.equal(updated.remediation.reason, 'Prepared targeted support set.');
  assert.equal(updated.remediation.remediationPack.totalSelected, 1);
});
