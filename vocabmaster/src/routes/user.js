const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');
const Word = require('../models/Word');
const LearningSession = require('../models/LearningSession');
const Progress = require('../models/Progress');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildCreatorStudentMetrics(students) {
  const activeToday = students.filter((student) => {
    if (!student.lastActivityDate) return false;
    return startOfDay(student.lastActivityDate).getTime() === startOfDay(new Date()).getTime();
  }).length;

  const averageAccuracy = students.length
    ? Math.round(students.reduce((sum, student) => sum + (student.accuracy || 0), 0) / students.length)
    : 0;

  return { activeToday, averageAccuracy };
}

// GET /api/user/stats - Get user statistics and progress
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = isDbConnected()
      ? await User.findById(req.user.id).lean()
      : devStore.findUserById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Calculate streak
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const lastSession = user.lastStudyDate ? new Date(user.lastStudyDate) : null;
    const lastSessionDate = lastSession ? new Date(lastSession) : null;
    lastSessionDate?.setHours(0, 0, 0, 0);

    let streak = user.currentStreak || 0;
    if (lastSessionDate && lastSessionDate.getTime() === today.getTime()) {
      // Same day, streak continues
    } else if (lastSessionDate && lastSessionDate.getTime() === new Date(today.getTime() - 86400000).getTime()) {
      // Yesterday, increment streak
      streak = (user.currentStreak || 0) + 1;
    } else {
      // Gap in streak
      streak = lastSessionDate && lastSessionDate.getTime() === today.getTime() ? (user.currentStreak || 1) : 0;
    }

    // Get learning progress
    const stats = {
      userId: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      totalXP: user.totalXP || 0,
      currentStreak: streak,
      lastStudyDate: user.lastStudyDate,
      longestStreak: user.longestStreak || 0,
      totalSessions: user.totalSessions || 0,
      averageAccuracy: user.averageAccuracy || 0,
    };

    // If creator, get student count and class stats
    if (user.role === 'creator') {
      if (!isDbConnected()) {
        const students = devStore
          .listUsers()
          .filter((entry) => (entry.role || 'student') === 'student' && String(entry.linkedCreatorCode || '').toUpperCase() === String(user.creatorCode || '').toUpperCase())
          .map((student) => {
            const progress = devStore.getProgressByUser(student._id) || {};
            return {
              id: student._id,
              name: student.name,
              email: student.email,
              createdAt: student.createdAt,
              totalXP: progress.totalXP || 0,
              lessonsCompleted: progress.lessonsCompleted || 0,
              accuracy: progress.accuracy || 0,
              streak: progress.streak || 0,
              lastActivityDate: progress.lastActivityDate || null,
            };
          });
        const metrics = buildCreatorStudentMetrics(students);
        stats.studentCount = students.length;
        stats.wordCount = devStore.getWordsByUser(user._id).length;
        stats.classCode = user.creatorCode;
        stats.activeToday = metrics.activeToday;
        stats.averageAccuracy = metrics.averageAccuracy;
      } else {
        const students = await User.find({
          role: 'student',
          linkedCreatorCode: user.creatorCode,
        }).select('_id').lean();
        const studentIds = students.map((student) => student._id);
        const progressRows = studentIds.length
          ? await Progress.find({ userId: { $in: studentIds } }).lean()
          : [];
        const metrics = buildCreatorStudentMetrics(progressRows.map((progress) => ({
          lastActivityDate: progress.lastActivityDate,
          accuracy: progress.accuracy,
        })));
        stats.studentCount = students.length;
        stats.wordCount = await Word.countDocuments({ userId: user._id });
        stats.classCode = user.creatorCode;
        stats.activeToday = metrics.activeToday;
        stats.averageAccuracy = metrics.averageAccuracy;
      }
    }

    // If student, get class info
    if (user.role === 'student' && user.linkedCreatorCode) {
      if (!isDbConnected()) {
        const creator = devStore.listUsers().find((entry) => String(entry.creatorCode || '').toUpperCase() === String(user.linkedCreatorCode || '').toUpperCase());
        stats.linkedCreator = creator ? { name: creator.name, email: creator.email } : null;
      } else {
        const creator = await User.findOne({ creatorCode: user.linkedCreatorCode }).select('name email');
        stats.linkedCreator = creator ? { name: creator.name, email: creator.email } : null;
      }
    }

    res.json(stats);
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// GET /api/user/students - Get students for the creator dashboard
router.get('/students', authMiddleware, async (req, res) => {
  try {
    const user = isDbConnected()
      ? await User.findById(req.user.id).lean()
      : devStore.findUserById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if ((user.role || 'student') !== 'creator') {
      return res.status(403).json({ message: 'Only creators can access student analytics' });
    }

    if (!isDbConnected()) {
      const students = devStore
        .listUsers()
        .filter((entry) => (entry.role || 'student') === 'student' && String(entry.linkedCreatorCode || '').toUpperCase() === String(user.creatorCode || '').toUpperCase())
        .map((student) => {
          const progress = devStore.getProgressByUser(student._id) || {};
          return {
            id: student._id,
            name: student.name,
            email: student.email,
            createdAt: student.createdAt,
            linkedCreatorCode: student.linkedCreatorCode || null,
            totalXP: progress.totalXP || 0,
            lessonsCompleted: progress.lessonsCompleted || 0,
            accuracy: progress.accuracy || 0,
            streak: progress.streak || 0,
            lastActivityDate: progress.lastActivityDate || null,
          };
        });

      const metrics = buildCreatorStudentMetrics(students);

      return res.json({
        students,
        totalStudents: students.length,
        activeToday: metrics.activeToday,
        averageAccuracy: metrics.averageAccuracy,
      });
    }

    const students = await User.find({
      role: 'student',
      linkedCreatorCode: user.creatorCode,
    })
      .select('_id name email createdAt linkedCreatorCode')
      .lean();

    const studentIds = students.map((student) => student._id);
    const progressRows = studentIds.length
      ? await Progress.find({ userId: { $in: studentIds } }).lean()
      : [];
    const progressByUserId = new Map(progressRows.map((row) => [String(row.userId), row]));

    const enriched = students.map((student) => {
      const progress = progressByUserId.get(String(student._id)) || {};
      return {
        id: student._id,
        name: student.name,
        email: student.email,
        createdAt: student.createdAt,
        linkedCreatorCode: student.linkedCreatorCode || null,
        totalXP: progress.totalXP || 0,
        lessonsCompleted: progress.lessonsCompleted || 0,
        accuracy: progress.accuracy || 0,
        streak: progress.streak || 0,
        lastActivityDate: progress.lastActivityDate || null,
      };
    });

    const metrics = buildCreatorStudentMetrics(enriched);

    res.json({
      students: enriched,
      totalStudents: enriched.length,
      activeToday: metrics.activeToday,
      averageAccuracy: metrics.averageAccuracy,
    });
  } catch (err) {
    console.error('Get students error:', err);
    res.status(500).json({ message: 'Failed to fetch students' });
  }
});

// POST /api/user/update-profile - Update user profile
router.post('/update-profile', authMiddleware, async (req, res) => {
  try {
    const { name, avatar } = req.body || {};
    const updates = {};

    if (name !== undefined) {
      if (String(name).trim().length < 2) {
        return res.status(400).json({ message: 'Name must be at least 2 characters' });
      }
      updates.name = String(name).trim();
    }

    if (avatar !== undefined) {
      if (typeof avatar === 'string' && avatar.length > 0) {
        updates.avatar = avatar;
      } else if (avatar === null) {
        updates.avatar = null;
      } else {
        return res.status(400).json({ message: 'Avatar must be a valid image string or null.' });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No profile changes provided.' });
    }

    if (!isDbConnected()) {
      const updated = devStore.updateUser(req.user.id, updates);
      if (!updated) return res.status(404).json({ message: 'User not found' });
      return res.json({
        _id: updated._id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        creatorCode: updated.creatorCode || null,
        linkedCreatorCode: updated.linkedCreatorCode || null,
        avatar: updated.avatar || null,
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      updates,
      { new: true, runValidators: true }
    ).select('-password -verificationToken');

    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// POST /api/user/change-password - Change password
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    if (!isDbConnected()) {
      const user = devStore.findUserById(req.user.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      devStore.updateUser(req.user.id, { passwordHash });
      return res.json({ message: 'Password changed successfully' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ message: 'Failed to change password' });
  }
});

module.exports = router;
