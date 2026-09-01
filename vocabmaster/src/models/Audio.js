const mongoose = require('mongoose');

// Audio assets for TTS, recordings, pronunciations
const audioAssetSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['word-tts', 'word-native', 'sentence-tts', 'sentence-native', 'user-recording', 'pronunciation-reference'],
    required: true,
  },
  
  // Reference to what this audio is for
  wordId: mongoose.Schema.Types.ObjectId, // If it's a word
  sentenceId: mongoose.Schema.Types.ObjectId, // If it's a sentence
  userId: mongoose.Schema.Types.ObjectId, // If it's a user recording
  
  language: { type: String, required: true }, // 'es', 'fr', etc.
  text: String, // The text that was spoken
  
  // Audio file
  url: String, // S3 or CDN URL
  mimeType: { type: String, default: 'audio/mp3' },
  duration: Number, // seconds
  sampleRate: Number, // 44100, etc.
  bitrate: String, // 128k, 192k, etc.
  
  // TTS metadata
  voice: String, // "es-MX-Lucia", "es-ES-Pablo"
  speed: { type: Number, default: 1.0 }, // 0.5 - 2.0x
  
  // Recording metadata
  uploadedAt: Date,
  recordedAt: Date,
  
  // Quality metrics
  quality: {
    type: String,
    enum: ['studio', 'good', 'acceptable', 'poor'],
    default: 'good',
  },
  
  // Pronunciation scoring (for user recordings)
  pronunciationScore: Number, // 0-100
  feedbackText: String,
  
  // Approval workflow
  approved: { type: Boolean, default: false },
  approvedBy: mongoose.Schema.Types.ObjectId,
  
  // Version control
  version: { type: Number, default: 1 },
  previousVersionUrl: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

audioAssetSchema.index({ wordId: 1, language: 1, type: 1 });
audioAssetSchema.index({ userId: 1, type: 1 });

const lessonProgressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  lessonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lesson',
    required: true,
  },
  
  // Progress tracking
  status: {
    type: String,
    enum: ['not-started', 'in-progress', 'completed', 'mastered'],
    default: 'not-started',
  },
  
  // Exercise attempts
  exerciseAttempts: [
    {
      exerciseId: mongoose.Schema.Types.ObjectId,
      attempts: Number, // How many times user answered
      correct: Number, // How many correct
      firstAttemptCorrect: Boolean,
      responses: [
        {
          answer: String,
          timestamp: Date,
          isCorrect: Boolean,
          responseTime: Number, // ms
        }
      ],
    }
  ],
  
  // Overall score
  score: Number, // 0-100
  perfectRun: Boolean, // No errors on first try
  
  // Timing
  startedAt: Date,
  completedAt: Date,
  totalTimeSpent: Number, // seconds
  
  // Gamification
  xpEarned: Number,
  heartsLost: Number,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

lessonProgressSchema.index({ userId: 1, lessonId: 1 }, { unique: true });
lessonProgressSchema.index({ userId: 1, status: 1 });

module.exports = {
  AudioAsset: mongoose.model('AudioAsset', audioAssetSchema),
  LessonProgress: mongoose.model('LessonProgress', lessonProgressSchema),
};
