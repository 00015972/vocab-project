const mongoose = require('mongoose');

const adminAuditSchema = new mongoose.Schema({
  adminId: {
    type: String,
    required: true,
  },
  adminEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  action: {
    type: String,
    required: true,
    trim: true,
  },
  targetUserId: {
    type: String,
    default: null,
  },
  targetEmail: {
    type: String,
    default: null,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model('AdminAudit', adminAuditSchema);
