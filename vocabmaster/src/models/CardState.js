const mongoose = require('mongoose');

// FSRS (Free Spaced Repetition System) algorithm state per word per user
const cardStateSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  wordId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Word',
    required: true,
  },
  // FSRS variables
  stability: { type: Number, default: 0, min: 0 }, // How well the word is remembered
  difficulty: { type: Number, default: 0.5, min: 0, max: 10 }, // 0-10 learner-perceived difficulty
  lastReview: Date,
  nextReview: {
    type: Date,
    default: () => new Date(), // Start immediately
  },
  nextReviewAt: {
    type: Date,
    default: () => new Date(),
  },
  reps: { type: Number, default: 0, min: 0 }, // Number of times reviewed
  repetitionCount: { type: Number, default: 0, min: 0 }, // Explicit alias for repetitions
  lapses: { type: Number, default: 0, min: 0 }, // Number of times failed
  state: {
    type: String,
    enum: ['new', 'learning', 'review', 'relearning'],
    default: 'new',
  },
  easeFactor: { type: Number, default: 2.5, min: 1.3, max: 3.2 }, // SM-2 ease (fallback)
  
  // Stats
  totalCorrect: { type: Number, default: 0, min: 0 },
  totalAttempts: { type: Number, default: 0, min: 0 },
  streak: { type: Number, default: 0, min: 0 },
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound index: one card state per user per word
cardStateSchema.index({ userId: 1, wordId: 1 }, { unique: true });
cardStateSchema.index({ userId: 1, nextReviewAt: 1 });

cardStateSchema.pre('validate', function syncSchedulingFields(next) {
  const toSafeNonNegativeInt = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  };

  // Keep nextReview and nextReviewAt in sync for backward compatibility.
  if (!this.nextReviewAt && this.nextReview) {
    this.nextReviewAt = this.nextReview;
  } else if (!this.nextReview && this.nextReviewAt) {
    this.nextReview = this.nextReviewAt;
  }

  // Keep reps and repetitionCount aligned to a single source of truth.
  const normalizedReps = Math.max(
    toSafeNonNegativeInt(this.reps),
    toSafeNonNegativeInt(this.repetitionCount)
  );
  this.reps = normalizedReps;
  this.repetitionCount = normalizedReps;

  this.lapses = toSafeNonNegativeInt(this.lapses);
  this.totalCorrect = toSafeNonNegativeInt(this.totalCorrect);
  this.totalAttempts = Math.max(
    toSafeNonNegativeInt(this.totalAttempts),
    this.totalCorrect
  );
  this.streak = toSafeNonNegativeInt(this.streak);
  next();
});

cardStateSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CardState', cardStateSchema);
