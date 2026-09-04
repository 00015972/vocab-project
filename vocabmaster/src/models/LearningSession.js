const mongoose = require('mongoose');

const learningSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    mode: { type: String, enum: ['flashcard', 'quiz', 'matching', 'spelling', 'pronunciation', 'timed-drill'], required: true },
    wordIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Word' }],
    
    // Session stats
    totalCards: { type: Number, required: true },
    correctAnswers: { type: Number, default: 0 },
    incorrectAnswers: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 }, // 0-100%
    
    // XP and combo
    xpEarned: { type: Number, default: 0 },
    maxCombo: { type: Number, default: 0 },
    
    // Duration
    durationSeconds: { type: Number, default: 0 },
    
    // Word-level stats
    wordPerformance: [
      {
        wordId: { type: mongoose.Schema.Types.ObjectId, ref: 'Word' },
        correct: { type: Boolean },
        quality: { type: Number, min: 0, max: 5 }, // For SM-2 algorithm
        timeSpent: { type: Number }, // milliseconds
      },
    ],

    // Creation date for analytics
    completedAt: { type: Date, index: true },
  },
  { timestamps: true }
);

// Calculate accuracy before saving
learningSessionSchema.pre('save', function (next) {
  const total = this.correctAnswers + this.incorrectAnswers;
  if (total > 0) {
    this.accuracy = Math.round((this.correctAnswers / total) * 100);
  }
  next();
});

// Index for efficient queries
learningSessionSchema.index({ userId: 1, createdAt: -1 });
learningSessionSchema.index({ userId: 1, mode: 1 });

module.exports = mongoose.model('LearningSession', learningSessionSchema);
