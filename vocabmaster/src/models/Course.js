const mongoose = require('mongoose');

// Core content structure: Course → Chapter → Lesson → Exercise
const exerciseSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['select', 'type', 'listen', 'speak', 'match', 'write', 'fill-blank'],
    required: true,
  },
  question: String, // "What does 'gato' mean?"
  prompt: String, // "Click the image that matches: gato"
  
  // Multiple choice or match options
  options: [
    {
      id: String,
      text: String,
      image: String, // URL to image
      isCorrect: Boolean,
    }
  ],
  
  // Correct answer
  correctAnswer: String,
  
  // Audio for "listen" exercises
  audioUrl: String, // TTS or recorded audio
  
  // Hints
  hint: String,
  explanation: String,
  
  // Difficulty level (affects XP)
  difficulty: { type: Number, min: 1, max: 5, default: 3 },
  
  // Metadata
  wordIds: [mongoose.Schema.Types.ObjectId], // Words practiced in this exercise
  conceptId: mongoose.Schema.Types.ObjectId, // Grammar concept (if applicable)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const lessonSchema = new mongoose.Schema({
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  chapterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chapter',
    required: true,
  },
  
  title: { type: String, required: true }, // "Food & Drinks"
  description: String,
  order: Number, // Position in chapter
  
  // Content
  exercises: [exerciseSchema],
  storyContext: String, // Narrative/story for this lesson
  characterId: mongoose.Schema.Types.ObjectId, // Which character teaches this
  
  // Learning targets
  objectives: [String], // What students should learn
  newWords: [mongoose.Schema.Types.ObjectId], // Word IDs introduced
  reviewWords: [mongoose.Schema.Types.ObjectId], // Previously learned words to review
  
  // Metadata
  difficulty: { type: Number, min: 1, max: 5, default: 2 },
  estimatedDuration: Number, // seconds
  version: { type: Number, default: 1 },
  isPublished: { type: Boolean, default: false },
  approvedBy: mongoose.Schema.Types.ObjectId, // Admin who approved
  
  // Analytics
  completionRate: { type: Number, default: 0 },
  averageScore: { type: Number, default: 0 },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const chapterSchema = new mongoose.Schema({
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  
  title: String, // "Basics"
  description: String,
  order: Number,
  
  // Content
  lessons: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }],
  theme: String, // Visual theme (color, emoji)
  
  // Metadata
  isCompleted: Boolean,
  difficulty: { type: Number, min: 1, max: 5 },
  
  createdAt: { type: Date, default: Date.now },
});

const courseSchema = new mongoose.Schema({
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  
  name: { type: String, required: true }, // "Spanish for Beginners"
  description: String,
  language: String, // "Spanish"
  targetLanguage: String, // Language learning (e.g., "Spanish")
  nativeLanguage: String, // Language teaching in (e.g., "English")
  
  // Structure
  chapters: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Chapter' }],
  enrolledStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  
  // Cover & branding
  coverImage: String,
  icon: String,
  color: String, // Brand color for course
  
  // Metadata
  level: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], default: 'A1' }, // CEFR
  version: { type: Number, default: 1 },
  isPublished: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
  approvedBy: mongoose.Schema.Types.ObjectId,
  
  // Stats
  studentCount: { type: Number, default: 0 },
  totalWords: { type: Number, default: 0 },
  completionRate: { type: Number, default: 0 },
  
  // SEO
  slug: String, // URL-friendly name
  tags: [String],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

courseSchema.index({ creatorId: 1, slug: 1 }, { unique: true });
courseSchema.index({ isPublic: 1, createdAt: -1 });

module.exports = {
  Course: mongoose.model('Course', courseSchema),
  Chapter: mongoose.model('Chapter', chapterSchema),
  Lesson: mongoose.model('Lesson', lessonSchema),
  Exercise: mongoose.model('Exercise', exerciseSchema),
};
