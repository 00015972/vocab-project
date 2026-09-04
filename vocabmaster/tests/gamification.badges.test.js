const test = require('node:test');
const assert = require('node:assert/strict');

const gamification = require('../src/utils/gamification');

test('speed-demon unlocks when daily session count reaches 5', () => {
  const userStats = {
    badges: [],
    totalSessionsCompleted: 5,
    totalXP: 0,
    level: 1,
    currentStreak: 1,
    studyModeStats: {
      flashcard: { sessions: 5, score: 80 },
      test: { sessions: 0, score: 0 },
      learn: { sessions: 0, score: 0 },
      match: { sessions: 0, score: 0 },
      write: { sessions: 0, score: 0 },
      live: { sessions: 0, score: 0 },
    },
    dailySessionCounts: {
      '2026-08-07': 4,
    },
  };

  const count = gamification.recordSessionDailyCount(userStats, '2026-08-07T10:00:00.000Z');
  assert.equal(count, 5);

  const badges = gamification.checkBadgeCompletion(userStats, {
    createdAt: '2026-08-07T10:00:00.000Z',
  });

  assert.equal(badges.includes('speed-demon'), true);
});

test('speed-demon does not unlock when sessions are split across days', () => {
  const userStats = {
    badges: [],
    totalSessionsCompleted: 5,
    totalXP: 0,
    level: 1,
    currentStreak: 2,
    studyModeStats: {
      flashcard: { sessions: 5, score: 80 },
      test: { sessions: 0, score: 0 },
      learn: { sessions: 0, score: 0 },
      match: { sessions: 0, score: 0 },
      write: { sessions: 0, score: 0 },
      live: { sessions: 0, score: 0 },
    },
    dailySessionCounts: {
      '2026-08-06': 4,
      '2026-08-07': 1,
    },
  };

  const badges = gamification.checkBadgeCompletion(userStats, {
    createdAt: '2026-08-07T10:00:00.000Z',
  });

  assert.equal(badges.includes('speed-demon'), false);
});

test('daily session counts are pruned to bounded history', () => {
  const userStats = {
    badges: [],
    studyModeStats: {},
    dailySessionCounts: {},
  };

  for (let day = 1; day <= 60; day += 1) {
    const key = `2026-06-${String(day).padStart(2, '0')}`;
    userStats.dailySessionCounts[key] = 1;
  }

  gamification.pruneDailySessionCounts(userStats, 45);
  assert.equal(Object.keys(userStats.dailySessionCounts).length <= 45, true);
});

test('updateStreak keeps streak for additional sessions on the same day', () => {
  const now = new Date();
  const sameDayEarlier = new Date(now);
  sameDayEarlier.setHours(Math.max(0, now.getHours() - 2), 0, 0, 0);

  const next = gamification.updateStreak(sameDayEarlier, 9);
  assert.equal(next, 9);
});

test('updateStreak increments when last study was yesterday', () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);

  const next = gamification.updateStreak(yesterday, 4);
  assert.equal(next, 5);
});

test('updateStreak resets when last study was older than yesterday', () => {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 3);
  oldDate.setHours(12, 0, 0, 0);

  const next = gamification.updateStreak(oldDate, 14);
  assert.equal(next, 1);
});
