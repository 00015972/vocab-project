/**
 * Gamification Logic for VocabMaster
 * Handles XP, levels, streaks, badges
 */

const BADGE_DEFINITIONS = {
  'first-step': { name: 'First Step', icon: '🎯', requirement: 'Complete first study session' },
  'streak-7': { name: '7-Day Warrior', icon: '🔥', requirement: '7 day streak' },
  'streak-30': { name: 'Month Master', icon: '⭐', requirement: '30 day streak' },
  'streak-100': { name: 'Century Scholar', icon: '👑', requirement: '100 day streak' },
  'xp-1000': { name: 'Rising Star', icon: '✨', requirement: '1,000 XP earned' },
  'xp-10000': { name: 'Legend', icon: '🏆', requirement: '10,000 XP earned' },
  'level-10': { name: 'Proficient', icon: '📚', requirement: 'Reach level 10' },
  'level-50': { name: 'Virtuoso', icon: '🎓', requirement: 'Reach level 50' },
  'perfect-10': { name: 'Flawless', icon: '🎪', requirement: 'Perfect score in 10 sessions' },
  'speed-demon': { name: 'Speed Demon', icon: '⚡', requirement: 'Complete 5 sessions in one day' },
  'study-all-modes': { name: 'Renaissance', icon: '🎨', requirement: 'Use all 6 study modes' },
};

class GamificationEngine {
  toDayKey(inputDate = new Date()) {
    const date = inputDate instanceof Date ? inputDate : new Date(inputDate);
    if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
    return date.toISOString().slice(0, 10);
  }

  normalizeDailySessionCounts(userStats) {
    const raw = userStats && userStats.dailySessionCounts ? userStats.dailySessionCounts : {};
    const pairs = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw);
    const normalized = {};
    for (const [key, value] of pairs) {
      const day = String(key || '').trim();
      if (!day) continue;
      const count = Number(value);
      normalized[day] = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    }
    return normalized;
  }

  pruneDailySessionCounts(userStats, maxDays = 45) {
    if (!userStats || typeof userStats !== 'object') return;
    const counts = this.normalizeDailySessionCounts(userStats);
    const sortedDays = Object.keys(counts).sort();
    if (sortedDays.length <= maxDays) {
      userStats.dailySessionCounts = counts;
      return;
    }

    const keep = sortedDays.slice(-maxDays);
    const next = {};
    keep.forEach((day) => {
      next[day] = counts[day];
    });
    userStats.dailySessionCounts = next;
  }

  recordSessionDailyCount(userStats, sessionDate = new Date()) {
    if (!userStats || typeof userStats !== 'object') return 0;
    const day = this.toDayKey(sessionDate);
    const counts = this.normalizeDailySessionCounts(userStats);
    counts[day] = Math.max(0, Number(counts[day] || 0)) + 1;
    userStats.dailySessionCounts = counts;
    this.pruneDailySessionCounts(userStats);
    return counts[day];
  }

  getDailySessionCount(userStats, sessionDate = new Date()) {
    const day = this.toDayKey(sessionDate);
    const counts = this.normalizeDailySessionCounts(userStats);
    return Math.max(0, Number(counts[day] || 0));
  }

  /**
   * Calculate XP for a study session
   * @param {object} session - Study session data
   * @returns {number} XP earned
   */
  calculateSessionXP(session) {
    let xp = 0;

    // Base XP: 10 per correct answer
    xp += (session.correctCount || 0) * 10;

    // Bonus for high accuracy (>80%)
    if (session.score > 80) xp += 20;
    if (session.score > 90) xp += 30;

    // Mode bonuses
    const modeMultipliers = {
      flashcard: 1.0,
      test: 1.1,
      learn: 1.2,
      match: 1.0,
      write: 1.3, // Hardest mode
      live: 1.5, // Competitive bonus
    };
    xp *= modeMultipliers[session.mode] || 1.0;

    // Duration bonus (reward extended study sessions)
    if (session.duration > 300) xp += 15; // +15 for >5 min
    if (session.duration > 900) xp += 30; // +30 for >15 min

    return Math.round(xp);
  }

  /**
   * Calculate level from total XP
   * Levels 1-100, exponential curve
   * Level 1 = 0 XP, Level 2 = 100 XP, etc.
   * @param {number} totalXP
   * @returns {number} Level (1-100)
   */
  calculateLevel(totalXP) {
    if (totalXP === 0) return 1;
    // Exponential formula: level ≈ log(totalXP / 10) + 1
    const level = Math.floor(Math.log10(totalXP / 10 + 1) * 20) + 1;
    return Math.min(level, 100);
  }

  /**
   * Get XP required for next level
   * @param {number} currentLevel
   * @returns {number} Total XP needed to reach next level
   */
  xpForNextLevel(currentLevel) {
    if (currentLevel >= 100) return null;
    // Exponential: level N requires 10^((N-1)/20) * 10 total XP
    return Math.round(Math.pow(10, currentLevel / 20) * 10);
  }

  /**
   * Check if user earned any new badges
   * @param {object} userStats - UserStats document
   * @param {object} session - Latest study session
   * @returns {array} Newly earned badge IDs
   */
  checkBadgeCompletion(userStats, session) {
    const badges = Array.isArray(userStats?.badges) ? userStats.badges : [];
    const modeStatsRaw = userStats?.studyModeStats && typeof userStats.studyModeStats === 'object'
      ? userStats.studyModeStats
      : {};
    const newBadges = [];

    // Check each badge
    if (!badges.includes('first-step') && userStats.totalSessionsCompleted >= 1) {
      newBadges.push('first-step');
    }

    if (!badges.includes('streak-7') && userStats.currentStreak >= 7) {
      newBadges.push('streak-7');
    }

    if (!badges.includes('streak-30') && userStats.currentStreak >= 30) {
      newBadges.push('streak-30');
    }

    if (!badges.includes('streak-100') && userStats.currentStreak >= 100) {
      newBadges.push('streak-100');
    }

    if (!badges.includes('xp-1000') && userStats.totalXP >= 1000) {
      newBadges.push('xp-1000');
    }

    if (!badges.includes('xp-10000') && userStats.totalXP >= 10000) {
      newBadges.push('xp-10000');
    }

    if (!badges.includes('level-10') && userStats.level >= 10) {
      newBadges.push('level-10');
    }

    if (!badges.includes('level-50') && userStats.level >= 50) {
      newBadges.push('level-50');
    }

    if (!badges.includes('perfect-10')) {
      const perfectSessions = modeStatsRaw;
      const hasPerfectScore = Object.values(perfectSessions).some((mode) => mode.sessions >= 10 && mode.score === 100);
      if (hasPerfectScore) newBadges.push('perfect-10');
    }

    if (!badges.includes('speed-demon')) {
      const sessionDate = session?.completedAt || session?.updatedAt || session?.createdAt || new Date();
      const explicitDailyCount = Number(session?.dailySessionCount);
      const dailySessionCount = Number.isFinite(explicitDailyCount)
        ? Math.max(0, Math.floor(explicitDailyCount))
        : this.getDailySessionCount(userStats, sessionDate);
      if (dailySessionCount >= 5) newBadges.push('speed-demon');
    }

    if (!badges.includes('study-all-modes')) {
      const modesUsed = Object.values(modeStatsRaw).filter((m) => m.sessions > 0).length;
      if (modesUsed === 6) newBadges.push('study-all-modes');
    }

    return newBadges;
  }

  /**
   * Update streak based on last study date
   * @param {Date} lastStudyDate - User's last study date
   * @param {number} currentStreak - Current streak count
   * @returns {number} New streak (either +1, reset to 1, or unchanged)
   */
  updateStreak(lastStudyDate, currentStreak) {
    if (!lastStudyDate) return 1; // First study session

    const today = new Date();
    const todayMidnight = new Date(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const lastStudy = new Date(lastStudyDate);
    lastStudy.setHours(0, 0, 0, 0);
    todayMidnight.setHours(0, 0, 0, 0);
    yesterday.setHours(0, 0, 0, 0);

    if (lastStudy.getTime() === yesterday.getTime()) {
      return currentStreak + 1; // Continued streak
    }

    if (lastStudy.getTime() === todayMidnight.getTime()) {
      return currentStreak; // Already studied today
    }

    return 1; // Streak broken, reset to 1
  }

  /**
   * Get all badge definitions
   * @returns {object} Badge info keyed by ID
   */
  getAllBadges() {
    return BADGE_DEFINITIONS;
  }
}

module.exports = new GamificationEngine();
