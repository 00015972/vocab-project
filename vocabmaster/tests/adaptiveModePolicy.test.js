const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSafeMode, buildModeAccess } = require('../src/services/adaptiveModePolicy');

test('resolveSafeMode falls back to an unlocked mode when the requested one is locked', () => {
  const plan = {
    masteryGates: {
      flashcards: { unlocked: true },
      matching: { unlocked: true },
      quiz: { unlocked: false, reason: 'Need more stability.' },
      spelling: { unlocked: false, reason: 'Need more precision.' },
    },
    unlockedModes: ['flashcards', 'matching'],
  };

  assert.equal(resolveSafeMode(plan, 'quiz', 'flashcards'), 'flashcards');
  assert.equal(resolveSafeMode(plan, 'spelling', 'matching'), 'matching');
});

test('buildModeAccess returns a structured lock response with a safe fallback', () => {
  const plan = {
    masteryGates: {
      quiz: { unlocked: false, reason: 'Need stronger recall.' },
    },
    unlockedModes: ['flashcards', 'matching'],
  };

  const access = buildModeAccess(plan, 'quiz', 'flashcards');
  assert.ok(access);
  assert.equal(access.requestedMode, 'quiz');
  assert.equal(access.fallbackMode, 'flashcards');
  assert.equal(access.safeMode, 'flashcards');
  assert.match(access.reason, /Need stronger recall/);
});
