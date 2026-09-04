const mongoose = require('mongoose');

const wordSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  deckId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Deck',
    default: null, // Can exist without deck
  },
  word: {
    type: String,
    required: [true, 'Word is required'],
    trim: true,
  },
  definition: {
    type: String,
    required: [true, 'Definition is required'],
  },
  partOfSpeech: {
    type: String,
    enum: ['noun', 'verb', 'adjective', 'adverb', 'phrase', 'idiom', 'other'],
    default: 'other',
  },
  example: String,
  notes: String,
  tags: [String],
  difficulty: {
    type: Number,
    min: 1,
    max: 5,
    default: 3,
  },
  domain: {
    type: String,
    trim: true,
    lowercase: true,
    default: 'general',
  },
  targetScoreRange: {
    type: String,
    enum: ['400-500', '500-600', '600-700', '700+'],
    default: '500-600',
  },
  learningStatus: {
    type: String,
    enum: ['locked', 'in_progress', 'mastered'],
    default: 'locked',
  },

  // Adaptive engine fields for recommendation and mastery gating
  adaptiveMetrics: {
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    correct: {
      type: Number,
      default: 0,
      min: 0,
    },
    incorrect: {
      type: Number,
      default: 0,
      min: 0,
    },
    consecutiveCorrectAcrossSessions: {
      type: Number,
      default: 0,
      min: 0,
    },
    averageLatencyMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastLatencyMs: {
      type: Number,
      default: 0,
      min: 0,
    },
    abilityDelta: {
      type: Number,
      default: 0,
    },
    itemDifficulty: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    dueAt: {
      type: Date,
      default: null,
    },
    masteredAt: {
      type: Date,
      default: null,
    },
    masteryStatus: {
      type: String,
      enum: ['locked', 'in_progress', 'mastered'],
      default: 'locked',
    },
    masteryUpdatedAt: {
      type: Date,
      default: null,
    },
    masteryRecentAccuracy: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    masterySessionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    masteryQualifyingSessions: {
      type: Number,
      default: 0,
      min: 0,
    },
    masteryDistinctDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    masterySpreadDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    masteryHistory: {
      type: [
        {
          sessionId: String,
          sessionAt: Date,
          correctCount: { type: Number, default: 0, min: 0 },
          totalCount: { type: Number, default: 0, min: 0 },
          accuracy: { type: Number, default: 0, min: 0, max: 100 },
          mode: String,
          responseTimeMs: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
  },
  
  // Alternative definitions (supports multiple meanings)
  alternativeDefinitions: [
    {
      definition: String,
      example: String,
    }
  ],
  
  // Etymology & mnemonics
  etymology: String,
  mnemonic: String,
  
  // Media
  pronunciation: String, // URL to audio
  imageUrl: String,
  
  // Deprecated (kept for backward compatibility)
  timesReviewed: {
    type: Number,
    default: 0,
  },
  timesCorrect: {
    type: Number,
    default: 0,
  },

  lastReviewedAt: Date,
  nextReviewAt: Date,
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

wordSchema.index({ userId: 1, createdAt: -1 });
wordSchema.index({ deckId: 1 });
wordSchema.index({ userId: 1, difficulty: 1, domain: 1, learningStatus: 1 });
wordSchema.index({ userId: 1, targetScoreRange: 1 });

module.exports = mongoose.model('Word', wordSchema);
