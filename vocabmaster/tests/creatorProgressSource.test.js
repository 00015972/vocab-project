const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStudentProgressSummary } = require('../src/routes/creator');

test('buildStudentProgressSummary prefers real Progress data over stale UserStats values', () => {
  const summary = buildStudentProgressSummary(
    { _id: 'student-1' },
    {
      totalXP: 320,
      streak: 12,
      wordsLearned: 50,
      accuracy: 91,
      lastActivityDate: '2026-08-26T10:00:00.000Z',
    },
    {
      totalXP: 20,
      currentStreak: 1,
      totalWordsLearned: 5,
      averageRetention: 35,
      level: 2,
    }
  );

  assert.equal(summary.totalXP, 320);
  assert.equal(summary.currentStreak, 12);
  assert.equal(summary.totalWordsLearned, 50);
  assert.equal(summary.accuracy, 91);
  assert.equal(summary.lastActivityDate, '2026-08-26T10:00:00.000Z');
  assert.equal(summary.level, 2);
});
