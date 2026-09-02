const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 12,
    maxlength: 128,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  role: {
    type: String,
    enum: ['creator', 'student', 'admin'],
    default: 'student',
  },
  
  // Creator/Student linking
  creatorCode: {
    type: String,
    trim: true,
    uppercase: true,
  },
  linkedCreatorCode: {
    type: String,
    trim: true,
    uppercase: true,
  },
  
  // Profile
  avatar: String, // URL to profile picture
  bio: String,
  
  // Preferences
  language: { type: String, default: 'en' },
  theme: { type: String, enum: ['light', 'dark'], default: 'dark' },
  notificationsEnabled: { type: Boolean, default: true },
  
  // Auth tokens
  verificationToken: { type: String, select: false },
  verificationExpires: Date,
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpires: Date,
  sessionVersion: { type: Number, default: 0, min: 0 },
  
  // Classes (for creators managing students)
  classes: [
    {
      name: String,
      code: String,
      students: [mongoose.Schema.Types.ObjectId], // Student IDs
      createdAt: { type: Date, default: Date.now },
    }
  ],
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastLogin: Date,
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.pre('validate', function (next) {
  if (this.creatorCode === null || String(this.creatorCode || '').trim() === '') {
    this.creatorCode = undefined;
  }
  if (this.linkedCreatorCode === null || String(this.linkedCreatorCode || '').trim() === '') {
    this.linkedCreatorCode = undefined;
  }
  next();
});

userSchema.index(
  { creatorCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      creatorCode: { $exists: true, $type: 'string' },
    },
  }
);

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
