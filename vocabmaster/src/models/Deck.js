const mongoose = require('mongoose');

const deckSchema = new mongoose.Schema({
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: [true, 'Deck name is required'],
    trim: true,
  },
  description: String,
  
  // Organization
  isPublic: { type: Boolean, default: false }, // Can be shared/forked
  isFeatured: { type: Boolean, default: false }, // Creator-marked as featured
  tags: [String],
  
  // Stats
  wordCount: { type: Number, default: 0 },
  downloads: { type: Number, default: 0 }, // Public deck downloads
  forks: [mongoose.Schema.Types.ObjectId], // Users who forked this deck
  
  // Metadata
  difficulty: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert'],
    default: 'intermediate',
  },
  language: { type: String, default: 'English' },
  topic: String, // e.g., "Business", "Medical", "Academic"
  
  // Thumbnail/cover
  coverImage: String, // URL
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

deckSchema.index({ creatorId: 1, name: 1 }, { unique: true });
deckSchema.index({ isPublic: 1, createdAt: -1 }); // For browsing public decks

module.exports = mongoose.model('Deck', deckSchema);
