const mongoose = require('mongoose');

const studySessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  wordIds: [mongoose.Schema.Types.ObjectId], // Words studied in this session
  mode: {
    type: String,
    enum: ['flashcard', 'test', 'learn', 'match', 'write', 'live'],
    required: true,
  },
  duration: Number, // in seconds
  score: Number, // 0-100
  correctCount: Number,
  totalCount: Number,
  responses: [
    {
      wordId: mongoose.Schema.Types.ObjectId,
      answer: String,
      correct: Boolean,
      responseTime: Number, // milliseconds
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('StudySession', studySessionSchema);
