const User = require('../models/User');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

module.exports = async (req, res, next) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let user;
    if (!isDbConnected()) {
      user = devStore.findUserById(userId);
    } else {
      user = await User.findById(userId).select('_id name email role createdAt').lean();
    }

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const role = String(user.role || 'student').toLowerCase();
    if (role !== 'admin' && role !== 'creator') {
      return res.status(403).json({ message: 'Control panel access required' });
    }

    req.adminUser = user;
    next();
  } catch (err) {
    console.error('Admin middleware error:', err);
    return res.status(500).json({ message: 'Failed to verify admin access' });
  }
};
