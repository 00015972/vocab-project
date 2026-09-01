const mongoose = require('mongoose');

const userStatsSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  // Gamification
  totalXP: { type: Number, default: 0 },
  level: { type: Number, default: 1 }, // 1-100
  currentStreak: { type: Number, default: 0 }, // Consecutive days studied
  longestStreak: { type: Number, default: 0 },
  lastStudyDate: Date,
  
  // Achievements/Badges
  badges: [String], // Array of achieved badge IDs
  
  // Learning stats
  totalSessionsCompleted: { type: Number, default: 0 },
  dailySessionCounts: {
    type: Map,
    of: Number,
    default: {},
  },
  totalWordsLearned: { type: Number, default: 0 }, // Words mastered
  totalWordsReviewing: { type: Number, default: 0 }, // In active review
  averageRetention: { type: Number, default: 0 }, // 0-100%
  totalStudyTime: { type: Number, default: 0 }, // in seconds
  
  // Study modes usage
  studyModeStats: {
    flashcard: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
    test: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
    learn: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
    match: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
    write: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
    live: { sessions: { type: Number, default: 0 }, score: { type: Number, default: 0 } },
  },
  
  // Leaderboard
  rank: Number,
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('UserStats', userStatsSchema);
