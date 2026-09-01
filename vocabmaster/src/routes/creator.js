const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Word = require('../models/Word');
const Deck = require('../models/Deck');
const Progress = require('../models/Progress');
const UserStats = require('../models/UserStats');
const auth = require('../middleware/auth');
const devStore = require('../services/devStore');
const { isDbConnected } = require('../config/db');
const { formatAnalyticsAsCSV, preparePdfData, generatePdfHtml } = require('../services/exportService');
const { evaluateGoalAlertState, buildGoalAlertPayload } = require('../services/goalAlertService');

router.use(auth);

function getCreatorUser(userId) {
  return isDbConnected()
    ? User.findById(userId).select('role creatorCode')
    : devStore.findUserById(userId);
}

function buildDevCreatorStudents(creatorCode) {
  const code = String(creatorCode || '').toUpperCase();
  return devStore
    .listUsers()
    .filter((entry) => (entry.role || 'student') === 'student' && String(entry.linkedCreatorCode || '').toUpperCase() === code)
    .map((student) => {
      const progress = devStore.getProgressByUser(student._id) || {};
      const level = Math.max(1, Math.floor((progress.totalXP || 0) / 100) + 1);
      return {
        id: student._id,
        name: student.name,
        email: student.email,
        createdAt: student.createdAt,
        lastLogin: student.lastLogin || null,
        totalXP: progress.totalXP || 0,
        level,
        currentStreak: progress.streak || 0,
        totalWordsLearned: progress.wordsLearned || 0,
        averageRetention: progress.averageRetention || 0,
        accuracy: progress.accuracy || 0,
        lastActivityDate: progress.lastActivityDate || null,
      };
    });
}

function buildDevCreatorDashboard(user) {
  const students = buildDevCreatorStudents(user.creatorCode);
  const words = devStore.getWordsByUser(user._id);
  const totalXPDistributed = students.reduce((sum, student) => sum + (student.totalXP || 0), 0);
  const avgStudentLevel = students.length
    ? (students.reduce((sum, student) => sum + (student.level || 1), 0) / students.length).toFixed(1)
    : '0';

  return {
    stats: {
      totalDecks: 0,
      totalWords: words.length,
      totalStudents: students.length,
      totalXPDistributed,
      avgStudentLevel,
    },
    recentDecks: [],
  };
}

function buildStudentProgressSummary(student, progress = {}, stats = {}) {
  const totalXP = Number(progress?.totalXP ?? stats?.totalXP ?? 0);
  const currentStreak = Number(progress?.streak ?? stats?.currentStreak ?? 0);
  const totalWordsLearned = Number(progress?.wordsLearned ?? stats?.totalWordsLearned ?? 0);
  const averageRetention = Number(progress?.averageRetention ?? stats?.averageRetention ?? 0);
  const accuracy = Number(progress?.accuracy ?? stats?.averageAccuracy ?? 0);
  const lastActivityDate = progress?.lastActivityDate || stats?.lastStudyDate || null;
  const level = Number(stats?.level || Math.max(1, Math.floor(totalXP / 100) + 1));

  return {
    id: student?._id || student?.id || null,
    name: student?.name || 'Student',
    email: student?.email || '',
    createdAt: student?.createdAt || null,
    lastLogin: student?.lastLogin || null,
    totalXP,
    level,
    currentStreak,
    totalWordsLearned,
    averageRetention,
    accuracy,
    lastActivityDate,
  };
}

function resolveScopeDomainFromDeck(deckId) {
  return String(deckId || '').trim() ? 'deck' : 'general';
}

// Ensure creator access
const creatorOnly = async (req, res, next) => {
  const user = await getCreatorUser(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (user.role !== 'creator') {
    return res.status(403).json({ message: 'Only creators can access this resource.' });
  }
  req.creatorUser = user;
  next();
};

// GET /api/creator/dashboard - Creator dashboard overview
router.get('/dashboard', auth, creatorOnly, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!isDbConnected()) {
      return res.json(buildDevCreatorDashboard(req.creatorUser || devStore.findUserById(userId)));
    }

    // Get creator stats
    const decks = await Deck.find({ creatorId: userId });
    const totalWords = await Word.countDocuments({ userId });
    const totalStudents = await User.countDocuments({
      role: 'student',
      linkedCreatorCode: req.creatorUser?.creatorCode,
    });

    // Get student progress from the real progress collection, with UserStats only as a fallback for level metadata.
    const studentIds = totalStudents
      ? (await User.find({ role: 'student', linkedCreatorCode: req.creatorUser?.creatorCode }).select('_id').lean()).map((student) => student._id)
      : [];
    const progressRows = studentIds.length
      ? await Progress.find({ userId: { $in: studentIds } }).select('userId totalXP streak wordsLearned accuracy lastActivityDate').lean()
      : [];
    const statsByUserId = new Map((await UserStats.find({ userId: { $in: studentIds } }).select('userId level totalXP currentStreak totalWordsLearned averageRetention').lean()).map((row) => [String(row.userId), row]));
    const studentProgress = progressRows.map((progress) => {
      const userId = String(progress.userId);
      return buildStudentProgressSummary({ _id: userId }, progress, statsByUserId.get(userId) || {});
    });

    const stats = {
      totalDecks: decks.length,
      totalWords,
      totalStudents,
      totalXPDistributed: studentProgress.reduce((sum, s) => sum + (s.totalXP || 0), 0),
      avgStudentLevel: studentProgress.length
        ? (studentProgress.reduce((sum, s) => sum + (s.level || 1), 0) / studentProgress.length).toFixed(1)
        : 0,
    };

    res.json({
      stats,
      recentDecks: decks.slice(-5).reverse(),
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch dashboard.' });
  }
});

// POST /api/creator/vocab/scope-sync - Normalize deck/general word scopes
router.post('/vocab/scope-sync', auth, creatorOnly, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!isDbConnected()) {
      const creatorWords = devStore.getWordsByUser(userId) || [];
      let updated = 0;
      creatorWords.forEach((entry) => {
        const desiredDomain = resolveScopeDomainFromDeck(entry && entry.deckId);
        if (String(entry && entry.domain || '').toLowerCase() === desiredDomain) return;
        const result = devStore.updateWord(entry._id, userId, { domain: desiredDomain });
        if (result) updated += 1;
      });
      return res.json({ message: 'Vocabulary scopes normalized.', updated });
    }

    const deckUpdate = await Word.updateMany(
      { userId, deckId: { $exists: true, $ne: null }, domain: { $ne: 'deck' } },
      { $set: { domain: 'deck' } }
    );

    const generalUpdate = await Word.updateMany(
      {
        userId,
        $or: [{ deckId: null }, { deckId: { $exists: false } }],
        domain: { $in: ['deck', '', null] },
      },
      { $set: { domain: 'general' } }
    );

    const updated = Number(deckUpdate.modifiedCount || 0) + Number(generalUpdate.modifiedCount || 0);
    return res.json({ message: 'Vocabulary scopes normalized.', updated });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to normalize vocabulary scopes.' });
  }
});

// GET /api/creator/students - List creator's students
router.get('/students', auth, creatorOnly, async (req, res) => {
  try {
    const user = await getCreatorUser(req.user.id);
    if (!user.creatorCode) {
      return res.json({ students: [] });
    }

    if (!isDbConnected()) {
      const students = buildDevCreatorStudents(user.creatorCode);
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const skip = Math.max(parseInt(req.query.skip) || 0, 0);
      return res.json({ students: students.slice(skip, skip + limit), total: students.length, limit, skip });
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);

    const total = await User.countDocuments({
      linkedCreatorCode: user.creatorCode,
    });

    const students = await User.find({ linkedCreatorCode: user.creatorCode })
      .select('name email createdAt lastLogin')
      .limit(limit)
      .skip(skip);

    const studentIds = students.map((student) => student._id);
    const progressRows = studentIds.length
      ? await Progress.find({ userId: { $in: studentIds } }).select('userId totalXP streak wordsLearned accuracy lastActivityDate').lean()
      : [];
    const progressByUserId = new Map(progressRows.map((row) => [String(row.userId), row]));
    const statsByUserId = new Map((await UserStats.find({ userId: { $in: studentIds } }).select('userId level totalXP currentStreak totalWordsLearned averageRetention').lean()).map((row) => [String(row.userId), row]));

    const studentData = students.map((s) => {
      const progress = progressByUserId.get(String(s._id)) || {};
      const stats = statsByUserId.get(String(s._id)) || {};
      const summary = buildStudentProgressSummary(s.toObject(), progress, stats);
      return {
        ...s.toObject(),
        stats: {
          level: summary.level,
          totalXP: summary.totalXP,
          streak: summary.currentStreak,
          wordsLearned: summary.totalWordsLearned,
          accuracy: summary.accuracy,
          lastActivityDate: summary.lastActivityDate,
        },
      };
    });

    res.json({ students: studentData, total, limit, skip });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch students.' });
  }
});

// POST /api/creator/students/:id/send-assignment - Send deck to student
router.post('/students/:id/send-assignment', auth, creatorOnly, async (req, res) => {
  try {
    const { deckId } = req.body;
    if (!deckId) {
      return res.status(400).json({ message: 'Deck ID is required.' });
    }

    const deck = await Deck.findById(deckId);
    if (!deck || deck.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const student = await User.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found.' });
    }

    // In a real app, would create an Assignment model
    // For now, just return success
    res.json({
      message: `Assignment sent to ${student.name}`,
      deckId,
      studentId: student._id,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send assignment.' });
  }
});

// GET /api/creator/analytics - Detailed analytics
router.get('/analytics', auth, creatorOnly, async (req, res) => {
  try {
    const userId = req.user.id;
    const timeRange = req.query.range || '30'; // days

    if (!isDbConnected()) {
      const user = req.creatorUser || devStore.findUserById(userId);
      const students = buildDevCreatorStudents(user.creatorCode);
      const words = devStore.getWordsByUser(userId);
      return res.json({
        decksCreated: 0,
        wordsCreated: words.length,
        totalDownloads: 0,
        averageDifficulty: words.length
          ? (words.reduce((sum, word) => sum + (word.difficulty || 3), 0) / words.length).toFixed(1)
          : 0,
        topDecks: [],
        activeStudents: students.filter((student) => student.lastActivityDate).length,
      });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(timeRange));

    // Get activity over time (would need StudySession model with timestamps)
    // For now, return basic analytics

    const decks = await Deck.find({ creatorId: userId });
    const words = await Word.find({ userId });

    const analytics = {
      decksCreated: decks.length,
      wordsCreated: words.length,
      totalDownloads: decks.reduce((sum, d) => sum + d.downloads, 0),
      averageDifficulty: words.length
        ? (words.reduce((sum, w) => sum + (w.difficulty || 3), 0) / words.length).toFixed(1)
        : 0,
      topDecks: decks.slice(0, 5).map((d) => ({
        name: d.name,
        wordCount: d.wordCount,
        downloads: d.downloads,
      })),
    };

    res.json(analytics);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch analytics.' });
  }
});

// GET /api/creator/export-progress - Export student progress
router.get('/export-progress', auth, creatorOnly, async (req, res) => {
  try {
    const user = await getCreatorUser(req.user.id);
    if (!user.creatorCode) {
      return res.status(400).json({ message: 'You have no students.' });
    }

    if (!isDbConnected()) {
      const students = buildDevCreatorStudents(user.creatorCode);
      const headers = ['Name', 'Email', 'Level', 'Total XP', 'Streak', 'Words Learned', 'Retention %', 'Last Active'];
      const rows = students.map((student) => [
        student.name,
        student.email,
        student.level,
        student.totalXP,
        student.currentStreak,
        student.totalWordsLearned,
        student.averageRetention,
        student.lastActivityDate || 'Never',
      ]);

      const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n');
      const filename = `student-progress-${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    const students = await User.find({ linkedCreatorCode: user.creatorCode });
    const progressData = [];
    const studentIds = students.map((student) => student._id);
    const progressRows = studentIds.length
      ? await Progress.find({ userId: { $in: studentIds } }).select('userId totalXP streak wordsLearned accuracy lastActivityDate').lean()
      : [];
    const progressByUserId = new Map(progressRows.map((row) => [String(row.userId), row]));
    const statsByUserId = new Map((await UserStats.find({ userId: { $in: studentIds } }).select('userId level totalXP currentStreak totalWordsLearned averageRetention').lean()).map((row) => [String(row.userId), row]));

    for (const student of students) {
      const progress = progressByUserId.get(String(student._id)) || {};
      const stats = statsByUserId.get(String(student._id)) || {};
      const summary = buildStudentProgressSummary(student, progress, stats);
      progressData.push({
        name: student.name,
        email: student.email,
        level: summary.level,
        totalXP: summary.totalXP,
        streak: summary.currentStreak,
        wordsLearned: summary.totalWordsLearned,
        averageRetention: summary.averageRetention,
        lastActive: summary.lastActivityDate || student.lastLogin || 'Never',
      });
    }

    // Export as CSV
    const headers = ['Name', 'Email', 'Level', 'Total XP', 'Streak', 'Words Learned', 'Retention %', 'Last Active'];
    const rows = progressData.map((p) => [
      p.name,
      p.email,
      p.level,
      p.totalXP,
      p.streak,
      p.wordsLearned,
      p.averageRetention,
      p.lastActive,
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n');

    const filename = `student-progress-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: 'Failed to export progress.' });
  }
});

// GET /api/creator/cohort-analytics - Cohort/class-level aggregated analytics
router.get('/cohort-analytics', auth, creatorOnly, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = req.creatorUser || devStore.findUserById(userId);
    
    // Validate creator has a creator code
    if (!user || !user.creatorCode) {
      return res.status(400).json({ message: 'Creator account is not properly configured. Missing creator code.' });
    }

    let students = [];
    if (!isDbConnected()) {
      students = buildDevCohortStudents(user.creatorCode);
    } else {
      // MongoDB path: fetch students and their progress
      const studentDocs = await User.find({ linkedCreatorCode: user.creatorCode }).select('_id name email createdAt').lean();
      const Progress = require('../models/Progress');
      students = await Promise.all(studentDocs.map(async (s) => {
        const progress = await Progress.findOne({ userId: s._id }).lean() || {};
        return buildStudentCohortRow(s, progress);
      }));
    }

    const totalStudents = students.length;
    const activeStudents = students.filter((s) => s.totalXP > 0 || s.sessionsCompleted > 0).length;
    const avgXP = totalStudents ? Math.round(students.reduce((sum, s) => sum + s.totalXP, 0) / totalStudents) : 0;
    
    // Calculate average accuracy: only from students who have completed sessions
    const studentsWithSessions = students.filter((s) => s.sessionsCompleted > 0);
    const avgAccuracy = studentsWithSessions.length
      ? Number((studentsWithSessions.reduce((sum, s) => sum + s.avgAccuracy, 0) / studentsWithSessions.length).toFixed(1))
      : 0;
    
    const avgSessions = totalStudents
      ? Number((students.reduce((sum, s) => sum + s.sessionsCompleted, 0) / totalStudents).toFixed(1))
      : 0;
    const totalSessionsAll = students.reduce((sum, s) => sum + s.sessionsCompleted, 0);

    // Class skill gaps: aggregate across all student completedLessons
    const classSkillGaps = deriveClassSkillGaps(students);

    // Top and bottom performers (by XP among active students)
    const ranked = [...students].sort((a, b) => b.totalXP - a.totalXP);
    const topPerformers = ranked.slice(0, 3);
    const struggling = ranked.filter((s) => s.totalXP === 0 || (s.sessionsCompleted > 0 && s.avgAccuracy < 70));

    return res.json({
      overview: { totalStudents, activeStudents, avgXP, avgAccuracy, avgSessions, totalSessionsAll },
      students,
      classSkillGaps,
      topPerformers,
      struggling,
    });
  } catch (err) {
    console.error('Error fetching cohort analytics:', err);
    res.status(500).json({ message: 'Failed to fetch cohort analytics.' });
  }
});

// GET /api/creator/export/analytics - Export cohort analytics as CSV or PDF
router.get('/export/analytics', auth, creatorOnly, async (req, res) => {
  try {
    console.log('\n=== EXPORT ENDPOINT DEBUG ===');
    console.log('DEBUG: Starting export request');
    
    const format = (req.query.format || 'csv').toLowerCase();
    
    // Validate format parameter
    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({ message: 'Invalid format. Use "csv" or "pdf".' });
    }

    const userId = req.user.id;
    console.log('DEBUG: User ID:', userId);
    
    const user = req.creatorUser || devStore.findUserById(userId);
    console.log('DEBUG: User found:', !!user, 'Has creatorCode:', !!user?.creatorCode);
    
    if (!user || !user.creatorCode) {
      return res.status(400).json({ message: 'Creator account is not properly configured.' });
    }

    // Fetch cohort analytics data (reuse cohort-analytics logic)
    let students = [];
    console.log('DEBUG: isDbConnected:', isDbConnected());
    
    if (!isDbConnected()) {
      console.log('DEBUG: Using devStore to build cohort students');
      students = buildDevCohortStudents(user.creatorCode);
      console.log('DEBUG: Got students from devStore:', students.length);
    } else {
      console.log('DEBUG: Using MongoDB to build cohort students');
      const studentDocs = await User.find({ linkedCreatorCode: user.creatorCode }).select('_id name email createdAt').lean();
      const Progress = require('../models/Progress');
      students = await Promise.all(studentDocs.map(async (s) => {
        const progress = await Progress.findOne({ userId: s._id }).lean() || {};
        return buildStudentCohortRow(s, progress);
      }));
      console.log('DEBUG: Got students from MongoDB:', students.length);
    }

    console.log('DEBUG: Students structure sample:', students[0] ? Object.keys(students[0]) : 'empty');
    
    const totalStudents = students.length;
    const activeStudents = students.filter((s) => s.totalXP > 0 || s.sessionsCompleted > 0).length;
    const avgXP = totalStudents ? Math.round(students.reduce((sum, s) => sum + s.totalXP, 0) / totalStudents) : 0;
    const studentsWithSessions = students.filter((s) => s.sessionsCompleted > 0);
    const avgAccuracy = studentsWithSessions.length
      ? Number((studentsWithSessions.reduce((sum, s) => sum + s.avgAccuracy, 0) / studentsWithSessions.length).toFixed(1))
      : 0;
    const avgSessions = totalStudents
      ? Number((students.reduce((sum, s) => sum + s.sessionsCompleted, 0) / totalStudents).toFixed(1))
      : 0;
    const totalSessionsAll = students.reduce((sum, s) => sum + s.sessionsCompleted, 0);

    console.log('DEBUG: Overview metrics calculated:', { totalStudents, activeStudents, avgXP, avgAccuracy, avgSessions, totalSessionsAll });

    const classSkillGaps = deriveClassSkillGaps(students);
    console.log('DEBUG: Skill gaps calculated:', classSkillGaps.length);
    
    const ranked = [...students].sort((a, b) => b.totalXP - a.totalXP);
    const topPerformers = ranked.slice(0, 3);
    const struggling = ranked.filter((s) => s.totalXP === 0 || (s.sessionsCompleted > 0 && s.avgAccuracy < 70));

    console.log('DEBUG: Top performers:', topPerformers.length, 'Struggling:', struggling.length);

    // Calculate vocabulary metadata - safely handle devStore
    let words = [];
    try {
      words = (isDbConnected() ? await Word.find({ userId }).lean() : devStore.getWordsByUser(user._id)) || [];
      console.log('DEBUG: Got words:', words.length);
    } catch (wordErr) {
      console.error('Error fetching words for metadata:', wordErr);
      words = [];
    }
    
    const avgDifficulty = words.length
      ? Number((words.reduce((sum, w) => sum + (w.difficulty || 5), 0) / words.length).toFixed(1))
      : 0;
    const wordsThisWeek = words.filter(w => {
      try {
        const createdDate = new Date(w.createdAt);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return createdDate >= weekAgo;
      } catch {
        return false;
      }
    }).length;
    const bestStreak = students.length > 0 ? Math.max(...students.map(s => s.streak || 0)) : 0;

    console.log('DEBUG: Vocabulary metadata:', { avgDifficulty, wordsThisWeek, bestStreak });

    const cohortData = {
      overview: { totalStudents, activeStudents, avgXP, avgAccuracy, avgSessions, totalSessionsAll },
      students,
      classSkillGaps,
      topPerformers,
      struggling,
      vocabularyMetadata: { avgDifficulty, wordsThisWeek, bestStreak },
    };

    console.log('DEBUG: Cohort data structure ready:', Object.keys(cohortData));
    console.log('DEBUG: Format requested:', format);
    console.log('=== EXPORT ENDPOINT DEBUG - DATA PREP DONE ===\n');

    // Generate export based on format
    if (format === 'csv') {
      try {
        console.log('DEBUG: About to format CSV. Cohort data:', JSON.stringify(cohortData, null, 2).substring(0, 500));
        console.log('DEBUG: Creator info:', { name: user.name, creatorCode: user.creatorCode });
        
        const csv = formatAnalyticsAsCSV(cohortData, { name: user.name, creatorCode: user.creatorCode });
        
        console.log('DEBUG: CSV formatted successfully. Length:', csv.length);
        const filename = `analytics-${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
      } catch (csvErr) {
        console.error('CSV formatting error - DETAILED:');
        console.error('  Error message:', csvErr.message);
        console.error('  Error stack:', csvErr.stack);
        console.error('  Cohort data structure:', Object.keys(cohortData));
        return res.status(500).json({ 
          message: 'Failed to format CSV export.',
          error: csvErr.message,
          debug: {
            dataKeys: Object.keys(cohortData),
            hasOverview: !!cohortData?.overview,
          }
        });
      }
    } else if (format === 'pdf') {
      try {
        console.log('DEBUG: About to format PDF. Cohort data keys:', Object.keys(cohortData));
        // For PDF, return data and let frontend generate PDF using jsPDF + html2canvas
        const pdfData = preparePdfData(cohortData, { name: user.name, creatorCode: user.creatorCode });
        const htmlContent = generatePdfHtml(pdfData);
        
        console.log('DEBUG: PDF formatted successfully. HTML length:', htmlContent.length);
        res.setHeader('Content-Type', 'application/json');
        res.json({
          format: 'pdf',
          html: htmlContent,
          filename: `analytics-${new Date().toISOString().split('T')[0]}.pdf`,
          cohortData, // Include for reference
        });
      } catch (pdfErr) {
        console.error('PDF formatting error - DETAILED:');
        console.error('  Error message:', pdfErr.message);
        console.error('  Error stack:', pdfErr.stack);
        return res.status(500).json({ 
          message: 'Failed to format PDF export.',
          error: pdfErr.message 
        });
      }
    }
  } catch (err) {
    console.error('Error exporting analytics:', err.message, err.stack);
    res.status(500).json({ message: 'Failed to export analytics: ' + err.message });
  }
});

function buildStudentCohortRow(user, progress) {
  const lessons = Array.isArray(progress?.completedLessons) ? progress.completedLessons : [];
  const sessionsCompleted = lessons.length;
  const totalXP = Number(progress?.totalXP || 0);
  const avgAccuracy = sessionsCompleted
    ? Number((lessons.reduce((sum, l) => sum + Number(l.accuracy || 0), 0) / sessionsCompleted).toFixed(1))
    : 0;
  const wordsLearned = Number(progress?.wordsLearned || 0);
  const streak = Number(progress?.streak || 0);
  const lastActivityDate = progress?.lastActivityDate || null;

  // Per-exercise type breakdown
  const byType = {};
  lessons.forEach((l) => {
    const t = String(l.type || 'other').toLowerCase();
    if (!byType[t]) byType[t] = { sessions: 0, totalAccuracy: 0 };
    byType[t].sessions += 1;
    byType[t].totalAccuracy += Number(l.accuracy || 0);
  });
  const exerciseBreakdown = Object.entries(byType).map(([type, data]) => ({
    type,
    sessions: data.sessions,
    avgAccuracy: Number((data.totalAccuracy / data.sessions).toFixed(1)),
  }));

  return {
    id: user._id,
    name: user.name || 'Unknown',
    email: user.email || '',
    totalXP,
    sessionsCompleted,
    avgAccuracy,
    wordsLearned,
    streak,
    lastActivityDate,
    exerciseBreakdown,
  };
}

function buildDevCohortStudents(creatorCode) {
  const code = String(creatorCode || '').toUpperCase();
  return devStore
    .listUsers()
    .filter((u) => u.role === 'student' && String(u.linkedCreatorCode || '').toUpperCase() === code)
    .map((user) => {
      const progress = devStore.getProgressByUser(user._id) || {};
      return buildStudentCohortRow(user, progress);
    });
}

function deriveClassSkillGaps(students) {
  // Aggregate exercise performance across ALL students
  const typeMap = {};
  students.forEach((s) => {
    (s.exerciseBreakdown || []).forEach((ex) => {
      if (!typeMap[ex.type]) typeMap[ex.type] = { totalAccuracy: 0, totalSessions: 0, studentCount: 0 };
      typeMap[ex.type].totalAccuracy += ex.avgAccuracy * ex.sessions;
      typeMap[ex.type].totalSessions += ex.sessions;
      typeMap[ex.type].studentCount += 1;
    });
  });

  return Object.entries(typeMap)
    .map(([type, data]) => ({
      type,
      avgAccuracy: data.totalSessions > 0 ? Number((data.totalAccuracy / data.totalSessions).toFixed(1)) : 0,
      totalSessions: data.totalSessions,
      studentCount: data.studentCount,
      severity: data.totalSessions > 0 && (data.totalAccuracy / data.totalSessions) < 70 ? 'high'
        : data.totalSessions > 0 && (data.totalAccuracy / data.totalSessions) < 80 ? 'medium' : 'ok',
    }))
    .filter((g) => g.severity !== 'ok')
    .sort((a, b) => a.avgAccuracy - b.avgAccuracy);
}

// ─── Goals CRUD + Progress ────────────────────────────────────────────────────

const VALID_METRICS = ['accuracy', 'avgXP', 'sessions', 'streak', 'activeRate', 'wordsLearned'];
const VALID_TIMEFRAMES = ['weekly', 'monthly', 'allTime'];

/**
 * Compute actual value for a given metric from current cohort data.
 * Returns { actual, unit, description }
 */
function computeActual(metric, students) {
  const total = students.length;
  if (total === 0) return { actual: 0, unit: '', description: 'No students yet' };

  switch (metric) {
    case 'accuracy': {
      const withSessions = students.filter((s) => s.sessionsCompleted > 0);
      const actual = withSessions.length
        ? Number((withSessions.reduce((sum, s) => sum + s.avgAccuracy, 0) / withSessions.length).toFixed(1))
        : 0;
      return { actual, unit: '%', description: 'Class average accuracy' };
    }
    case 'avgXP': {
      const actual = Math.round(students.reduce((sum, s) => sum + s.totalXP, 0) / total);
      return { actual, unit: 'XP', description: 'Average XP per student' };
    }
    case 'sessions': {
      const actual = Number((students.reduce((sum, s) => sum + s.sessionsCompleted, 0) / total).toFixed(1));
      return { actual, unit: 'sessions', description: 'Average sessions per student' };
    }
    case 'streak': {
      const actual = students.length > 0 ? Math.max(...students.map((s) => s.streak || 0)) : 0;
      return { actual, unit: 'days', description: 'Best student streak' };
    }
    case 'activeRate': {
      const active = students.filter((s) => s.totalXP > 0 || s.sessionsCompleted > 0).length;
      const actual = Number(((active / total) * 100).toFixed(1));
      return { actual, unit: '%', description: 'Student engagement rate' };
    }
    case 'wordsLearned': {
      const actual = Math.round(students.reduce((sum, s) => sum + (s.wordsLearned || 0), 0) / total);
      return { actual, unit: 'words', description: 'Average words learned per student' };
    }
    default:
      return { actual: 0, unit: '', description: '' };
  }
}

/**
 * Determine goal status based on actual vs target.
 * Returns: achieved | on_track | at_risk | behind | not_started
 */
function computeGoalStatus(actual, target) {
  if (target <= 0) return 'not_started';
  const pct = (actual / target) * 100;
  if (pct >= 100) return 'achieved';
  if (pct >= 75) return 'on_track';
  if (pct >= 40) return 'at_risk';
  return 'behind';
}

function getWindowDaysForTimeframe(timeframe) {
  if (timeframe === 'weekly') return 7;
  if (timeframe === 'monthly') return 30;
  return 0; // allTime = no filter
}

/**
 * Build a cohort row for a student filtered to a specific time window.
 * windowDays=0 means allTime (no filter).
 */
function buildStudentCohortRowWindowed(user, progress, windowDays) {
  if (!windowDays) return buildStudentCohortRow(user, progress);

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (windowDays - 1));
  cutoff.setUTCHours(0, 0, 0, 0);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const allLessons = Array.isArray(progress?.completedLessons) ? progress.completedLessons : [];
  const windowedLessons = allLessons.filter((l) => {
    const at = l?.date ? new Date(l.date) : null;
    return at && !Number.isNaN(at.getTime()) && at >= cutoff;
  });

  const windowedXP = windowedLessons.reduce((sum, l) => sum + Number(l.xp || 0), 0);
  const windowedWords = (Array.isArray(progress?.dailyHistory) ? progress.dailyHistory : [])
    .filter((row) => String(row.dateKey || '') >= cutoffKey)
    .reduce((sum, row) => sum + Number(row.wordsLearned || 0), 0);

  return buildStudentCohortRow(user, {
    ...progress,
    totalXP: windowedXP,
    completedLessons: windowedLessons,
    wordsLearned: windowedWords,
  });
}

function buildDevCohortStudentsWindowed(creatorCode, windowDays) {
  const code = String(creatorCode || '').toUpperCase();
  return devStore
    .listUsers()
    .filter((u) => u.role === 'student' && String(u.linkedCreatorCode || '').toUpperCase() === code)
    .map((user) => {
      const progress = devStore.getProgressByUser(user._id) || {};
      return buildStudentCohortRowWindowed(user, progress, windowDays);
    });
}

// GET /api/creator/goals — list all goals for this creator
router.get('/goals', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.json({ goals: [] });
    const goals = devStore.getGoalsByCreator(user.creatorCode);
    res.json({ goals });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch goals.' });
  }
});

// GET /api/creator/goals/progress — goals with actual vs target computed
router.get('/goals/progress', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.json({ goalsProgress: [] });

    const goals = devStore.getGoalsByCreator(user.creatorCode);
    if (goals.length === 0) return res.json({ goalsProgress: [] });

    // Build one cohort per unique timeframe to avoid redundant queries
    const timeframes = [...new Set(goals.map((g) => g.timeframe || 'allTime'))];
    const cohortByTimeframe = {};

    for (const tf of timeframes) {
      const windowDays = getWindowDaysForTimeframe(tf);
      if (!isDbConnected()) {
        cohortByTimeframe[tf] = windowDays > 0
          ? buildDevCohortStudentsWindowed(user.creatorCode, windowDays)
          : buildDevCohortStudents(user.creatorCode);
      } else {
        const Progress = require('../models/Progress');
        const studentDocs = await User.find({ linkedCreatorCode: user.creatorCode })
          .select('_id name email createdAt').lean();
        cohortByTimeframe[tf] = await Promise.all(studentDocs.map(async (s) => {
          const progress = await Progress.findOne({ userId: s._id }).lean() || {};
          return buildStudentCohortRowWindowed(s, progress, windowDays);
        }));
      }
    }

    const goalsProgress = goals.map((goal) => {
      const tf = goal.timeframe || 'allTime';
      const students = cohortByTimeframe[tf] || [];
      const { actual, unit, description } = computeActual(goal.metric, students);
      const alertState = evaluateGoalAlertState(goal, actual);
      return {
        ...goal,
        actual,
        unit,
        description,
        pct: alertState.percent,
        status: alertState.status,
        severity: alertState.severity,
        alert: buildGoalAlertPayload(goal, actual),
      };
    });

    const alerts = devStore.getAlertsByCreator(user.creatorCode).filter((alert) => !alert.dismissed);
    const alertsByGoal = new Map(alerts.map((alert) => [String(alert.goalId), alert]));
    const enrichedGoalsProgress = goalsProgress.map((goal) => {
      const existingAlert = alertsByGoal.get(String(goal._id));
      if (!existingAlert) return goal;
      return {
        ...goal,
        persistedAlert: {
          _id: existingAlert._id,
          dismissed: existingAlert.dismissed,
          reviewed: existingAlert.reviewed,
          status: existingAlert.status,
          severity: existingAlert.severity,
          message: existingAlert.message,
        },
      };
    });

    res.json({ goalsProgress: enrichedGoalsProgress, alerts });
  } catch (err) {
    console.error('Goals progress error:', err);
    res.status(500).json({ message: 'Failed to compute goal progress.' });
  }
});

// GET /api/creator/alerts — list creator alerts
router.get('/alerts', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.json({ alerts: [] });
    const alerts = devStore.getAlertsByCreator(user.creatorCode);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch alerts.' });
  }
});

// POST /api/creator/alerts — create or refresh an alert for a goal
router.post('/alerts', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const { goalId, status, severity, message } = req.body || {};
    if (!goalId) return res.status(400).json({ message: 'Goal ID is required.' });

    const existing = devStore.getAlertsByCreator(user.creatorCode).find((alert) => String(alert.goalId) === String(goalId));
    if (existing) {
      const updated = devStore.updateAlert(existing._id, user.creatorCode, {
        status,
        severity,
        message,
        dismissed: false,
        reviewed: false,
      });
      return res.json({ alert: updated });
    }

    const alert = devStore.createAlert(user.creatorCode, {
      goalId,
      status,
      severity,
      message,
      dismissed: false,
      reviewed: false,
    });
    res.status(201).json({ alert });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save alert.' });
  }
});

// PATCH /api/creator/alerts/:id/dismiss — dismiss an alert
router.patch('/alerts/:id/dismiss', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const updated = devStore.updateAlert(req.params.id, user.creatorCode, { dismissed: true, reviewed: true });
    if (!updated) return res.status(404).json({ message: 'Alert not found.' });
    res.json({ alert: updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to dismiss alert.' });
  }
});

// PATCH /api/creator/alerts/:id/review — mark an alert as reviewed
router.patch('/alerts/:id/review', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const updated = devStore.updateAlert(req.params.id, user.creatorCode, { reviewed: true });
    if (!updated) return res.status(404).json({ message: 'Alert not found.' });
    res.json({ alert: updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to review alert.' });
  }
});

// POST /api/creator/goals — create a new goal
router.post('/goals', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const { label, metric, target, timeframe } = req.body;

    if (!label || typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ message: 'Goal label is required.' });
    }
    if (!VALID_METRICS.includes(metric)) {
      return res.status(400).json({ message: `Invalid metric. Use one of: ${VALID_METRICS.join(', ')}` });
    }
    if (!target || isNaN(Number(target)) || Number(target) <= 0) {
      return res.status(400).json({ message: 'Target must be a positive number.' });
    }
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ message: `Invalid timeframe. Use one of: ${VALID_TIMEFRAMES.join(', ')}` });
    }

    const goal = devStore.createGoal(user.creatorCode, { label, metric, target: Number(target), timeframe });
    res.status(201).json({ goal });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create goal.' });
  }
});

// PUT /api/creator/goals/:id — update a goal
router.put('/goals/:id', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const { label, metric, target, timeframe } = req.body;

    if (metric && !VALID_METRICS.includes(metric)) {
      return res.status(400).json({ message: `Invalid metric. Use one of: ${VALID_METRICS.join(', ')}` });
    }
    if (target !== undefined && (isNaN(Number(target)) || Number(target) <= 0)) {
      return res.status(400).json({ message: 'Target must be a positive number.' });
    }
    if (timeframe && !VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ message: `Invalid timeframe. Use one of: ${VALID_TIMEFRAMES.join(', ')}` });
    }

    const payload = {};
    if (label !== undefined) payload.label = label;
    if (metric !== undefined) payload.metric = metric;
    if (target !== undefined) payload.target = Number(target);
    if (timeframe !== undefined) payload.timeframe = timeframe;

    const goal = devStore.updateGoal(req.params.id, user.creatorCode, payload);
    if (!goal) return res.status(404).json({ message: 'Goal not found.' });

    res.json({ goal });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update goal.' });
  }
});

// DELETE /api/creator/goals/:id — delete a goal
router.delete('/goals/:id', auth, creatorOnly, async (req, res) => {
  try {
    const user = req.creatorUser || devStore.findUserById(req.user.id);
    if (!user?.creatorCode) return res.status(400).json({ message: 'Creator account not configured.' });

    const deleted = devStore.deleteGoal(req.params.id, user.creatorCode);
    if (!deleted) return res.status(404).json({ message: 'Goal not found.' });

    res.json({ message: 'Goal deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete goal.' });
  }
});

module.exports = router;
module.exports.buildStudentProgressSummary = buildStudentProgressSummary;
