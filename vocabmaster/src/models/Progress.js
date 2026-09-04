const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const dailyHistorySchema = new mongoose.Schema(
  {
    // YYYY-MM-DD in UTC to make range queries and chart grouping predictable.
    dateKey: {
      type: String,
      required: true,
      trim: true,
    },
    xpEarned: {
      type: Number,
      default: 0,
      min: 0,
    },
    wordsLearned: {
      type: Number,
      default: 0,
      min: 0,
    },
    quizzesCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
    avgAccuracy: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    studyMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    sessionsCompleted: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const progressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  totalXP: {
    type: Number,
    default: 0,
  },
  streak: {
    type: Number,
    default: 0,
  },
  longestStreak: {
    type: Number,
    default: 0,
  },
  lessonsCompleted: {
    type: Number,
    default: 0,
  },
  wordsLearned: {
    type: Number,
    default: 0,
  },
  accuracy: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  totalStudyTime: {
    type: Number,
    default: 0,
  },
  adaptiveProfile: {
    targetLevel: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
      default: 'A1',
    },
    abilityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    difficultyBand: {
      min: { type: Number, default: 1, min: 1, max: 5 },
      max: { type: Number, default: 2, min: 1, max: 5 },
    },
    diagnostic: {
      completedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0, min: 0 },
      correct: { type: Number, default: 0, min: 0 },
      accuracy: { type: Number, default: 0, min: 0, max: 100 },
      averageLatencyMs: { type: Number, default: 0, min: 0 },
      sessionToken: { type: String, default: null },
    },
    behaviorSignals: {
      baselineLatencyMs: { type: Number, default: 2200, min: 0 },
      confidenceScore: { type: Number, default: 0.6, min: 0, max: 1 },
      fastGuessRate: { type: Number, default: 0, min: 0, max: 1 },
      slowStruggleRate: { type: Number, default: 0, min: 0, max: 1 },
      recentBehaviors: { type: [String], default: [] },
      updatedAt: { type: Date, default: null },
    },
    masteryGates: {
      flashcards: {
        unlocked: { type: Boolean, default: true },
        reason: { type: String, default: 'Available by default.' },
        requiredSubSkills: { type: [String], default: [] },
        subSkills: { type: Schema.Types.Mixed, default: {} },
        lastUnlockedAt: { type: Date, default: null },
        lastLockedAt: { type: Date, default: null },
        transitionCount: { type: Number, default: 0, min: 0 },
        transitionHistory: { type: [Schema.Types.Mixed], default: [] },
      },
      matching: {
        unlocked: { type: Boolean, default: false },
        reason: { type: String, default: 'Improve confidence or accuracy to unlock.' },
        requiredSubSkills: { type: [String], default: [] },
        subSkills: { type: Schema.Types.Mixed, default: {} },
        lastUnlockedAt: { type: Date, default: null },
        lastLockedAt: { type: Date, default: null },
        transitionCount: { type: Number, default: 0, min: 0 },
        transitionHistory: { type: [Schema.Types.Mixed], default: [] },
      },
      quiz: {
        unlocked: { type: Boolean, default: false },
        reason: { type: String, default: 'Improve confidence or accuracy to unlock.' },
        requiredSubSkills: { type: [String], default: [] },
        subSkills: { type: Schema.Types.Mixed, default: {} },
        lastUnlockedAt: { type: Date, default: null },
        lastLockedAt: { type: Date, default: null },
        transitionCount: { type: Number, default: 0, min: 0 },
        transitionHistory: { type: [Schema.Types.Mixed], default: [] },
      },
      spelling: {
        unlocked: { type: Boolean, default: false },
        reason: { type: String, default: 'Improve confidence or accuracy to unlock.' },
        requiredSubSkills: { type: [String], default: [] },
        subSkills: { type: Schema.Types.Mixed, default: {} },
        lastUnlockedAt: { type: Date, default: null },
        lastLockedAt: { type: Date, default: null },
        transitionCount: { type: Number, default: 0, min: 0 },
        transitionHistory: { type: [Schema.Types.Mixed], default: [] },
      },
    },
    remediation: {
      active: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      focusModes: { type: [String], default: [] },
      recommendedWordIds: { type: [String], default: [] },
      updatedAt: { type: Date, default: null },
    },
  },
  completedLessons: {
    type: [{
      type: { type: String, default: 'flashcards' },
      date: { type: Date, default: Date.now },
      xp: { type: Number, default: 0 },
      accuracy: { type: Number, default: 0 },
      duration: { type: Number, default: 0 },
    }],
    default: [],
  },
  dailyHistory: {
    type: [dailyHistorySchema],
    default: [],
  },
  adaptiveQueue: {
    generatedAt: { type: Date, default: null },
    targetWords: { type: Number, default: 0 },
    dueReviewCount: { type: Number, default: 0 },
    remediationCount: { type: Number, default: 0 },
    mix: {
      totalRequested: { type: Number, default: 0 },
      targetCounts: {
        current: { type: Number, default: 0 },
        stretch: { type: Number, default: 0 },
        review: { type: Number, default: 0 },
      },
      counts: {
        current: { type: Number, default: 0 },
        stretch: { type: Number, default: 0 },
        review: { type: Number, default: 0 },
      },
      ratios: {
        current: { type: Number, default: 0.7 },
        stretch: { type: Number, default: 0.2 },
        review: { type: Number, default: 0.1 },
      },
    },
    queuePreview: {
      type: [{
        wordId: String,
        word: String,
        hint: String,
        imageUrl: String,
        difficulty: Number,
        source: String,
        position: Number,
      }],
      default: [],
    },
    activeQueue: {
      planId: { type: String, default: null },
      queueId: { type: String, default: null },
      status: {
        type: String,
        enum: ['active', 'completed', 'abandoned', 'expired'],
        default: null,
      },
      version: { type: Number, default: 1 },
      createdAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      abandonedAt: { type: Date, default: null },
      settings: {
        minutes: { type: Number, default: 20 },
        wordCount: { type: Number, default: 16 },
        targetLevel: { type: String, default: 'AUTO' },
        hearts: { type: Number, default: 5 },
        difficultyBand: {
          min: { type: Number, default: 1 },
          max: { type: Number, default: 5 },
          label: { type: String, default: 'Auto' },
        },
      },
      cursor: {
        nextIndex: { type: Number, default: 0 },
        completedCount: { type: Number, default: 0 },
      },
      modeProgress: {
        flashcards: { type: Number, default: 0 },
        quiz: { type: Number, default: 0 },
        matching: { type: Number, default: 0 },
        spelling: { type: Number, default: 0 },
      },
      items: {
        type: [{
          queueItemId: String,
          position: Number,
          wordId: String,
          word: String,
          definition: String,
          hint: String,
          imageUrl: String,
          difficulty: Number,
          source: String,
          status: { type: String, default: 'pending' },
          attempts: { type: Number, default: 0 },
          correctAttempts: { type: Number, default: 0 },
          latencyMsAvg: { type: Number, default: 0 },
          lastLatencyMs: { type: Number, default: 0 },
          behavior: { type: String, default: null },
          learningStatus: { type: String, default: 'new' },
          requeueCount: { type: Number, default: 0, min: 0 },
          lastMode: { type: String, default: null },
          lastAttemptAt: { type: Date, default: null },
        }],
        default: [],
      },
      attemptLedger: {
        type: [{
          idempotencyKey: String,
          queueItemId: String,
          mode: String,
          accepted: Boolean,
          advancedToIndex: Number,
          version: Number,
          response: mongoose.Schema.Types.Mixed,
          createdAt: { type: Date, default: Date.now },
        }],
        default: [],
      },
    },
  },
  lastActivityDate: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for idempotency lookup to speed replay detection
progressSchema.index({ 'adaptiveQueue.activeQueue.attemptLedger.idempotencyKey': 1 });

module.exports = mongoose.model('Progress', progressSchema);
