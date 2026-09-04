const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const StudySession = require('../models/StudySession');
const CardState = require('../models/CardState');
const UserStats = require('../models/UserStats');
const Progress = require('../models/Progress');
const Word = require('../models/Word');
const User = require('../models/User');
const auth = require('../middleware/auth');
const fsrsScheduler = require('../utils/fsrsScheduler');
const gamification = require('../utils/gamification');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');
const { updateMasteryStatus } = require('../services/masteryTracking');
const {
  inferTargetLevelFromAbilityScore,
  difficultyBandFromAbilityScore,
  updateAbilityEstimate,
  normalizeItemDifficulty,
} = require('../services/irtLite');

const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';
const DIAGNOSTIC_SESSION_TTL_MS = 30 * 60 * 1000;
const diagnosticSessions = new Map();

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function shuffleArray(input) {
  const arr = Array.isArray(input) ? input.slice() : [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeWordDifficulty(value) {
  return clampNumber(value, 1, 5, 3);
}

function normalizeGrade(grade, fallback = '3') {
  const raw = String(grade || fallback).trim().toLowerCase();
  if (['1', 'again'].includes(raw)) return '1';
  if (['2', 'hard'].includes(raw)) return '2';
  if (['3', 'good'].includes(raw)) return '3';
  if (['4', 'easy'].includes(raw)) return '4';
  return String(fallback || '3');
}

function resolveReviewGrade(response = {}) {
  const isCorrect = response && response.correct === true;
  if (!isCorrect) return '1';

  const normalized = normalizeGrade(response.grade, '3');
  // Successful answers should not map to a failure grade.
  return normalized === '1' ? '3' : normalized;
}

function pickNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function markLapse(cardState) {
  if (!cardState || typeof cardState !== 'object') return cardState;
  cardState.lapses = Math.max(0, Number(cardState.lapses || 0)) + 1;
  cardState.streak = 0;
  return cardState;
}

function scheduleNextReview(cardState, grade) {
  if (!cardState || typeof cardState !== 'object') return cardState;

  const normalizedGrade = normalizeGrade(grade, '3');
  const fsrsUpdate = fsrsScheduler.calculateNextInterval(
    Number(cardState.stability || 0),
    Number(cardState.difficulty || 0.5),
    normalizedGrade,
    String(cardState.state || 'new')
  );

  const now = new Date();
  const nextReviewAt = new Date(now.getTime() + Number(fsrsUpdate.nextInterval || 1) * 24 * 60 * 60 * 1000);
  const previousReps = Math.max(0, Number(cardState.reps || 0));
  const previousRepetitionCount = Math.max(0, Number(cardState.repetitionCount || previousReps));
  const nextStability = Number(fsrsUpdate.newStability);
  const nextDifficulty = Number(fsrsUpdate.newDifficulty);

  cardState.stability = Number.isFinite(nextStability)
    ? Math.max(0, nextStability)
    : Math.max(0, Number(cardState.stability || 0));
  cardState.difficulty = Number.isFinite(nextDifficulty)
    ? Math.max(0, Math.min(10, nextDifficulty))
    : Math.max(0, Math.min(10, Number(cardState.difficulty || 0.5)));
  cardState.state = String(fsrsUpdate.state || cardState.state || 'learning');
  cardState.nextReview = nextReviewAt;
  cardState.nextReviewAt = nextReviewAt;
  cardState.lastReview = now;
  cardState.reps = previousReps + 1;
  cardState.repetitionCount = previousRepetitionCount + 1;
  cardState.totalAttempts = Math.max(0, Number(cardState.totalAttempts || 0)) + 1;

  if (normalizedGrade === '1') {
    markLapse(cardState);
  } else {
    cardState.totalCorrect = Math.max(0, Number(cardState.totalCorrect || 0)) + 1;
    cardState.streak = Math.max(0, Number(cardState.streak || 0)) + 1;
  }

  const ease = Number(cardState.easeFactor || 2.5);
  const easeDeltaMap = { '1': -0.2, '2': -0.15, '3': 0.05, '4': 0.15 };
  const nextEase = Math.max(1.3, Math.min(3.2, ease + (easeDeltaMap[normalizedGrade] || 0)));
  cardState.easeFactor = Number(nextEase.toFixed(2));

  return cardState;
}

async function queueDueCards(userId, now = new Date(), options = {}) {
  const maybeDate = now instanceof Date ? now : new Date(now);
  const asOf = Number.isNaN(maybeDate.getTime()) ? new Date() : maybeDate;
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
  const overFetchMultiplier = options.deckId ? 6 : 1;
  const queryLimit = Math.max(limit, Math.min(500, limit * overFetchMultiplier));

  const effectiveDueTime = (card) => {
    const primary = new Date(card?.nextReviewAt || '');
    if (!Number.isNaN(primary.getTime())) return primary.getTime();
    const fallback = new Date(card?.nextReview || '');
    if (!Number.isNaN(fallback.getTime())) return fallback.getTime();
    return Number.MAX_SAFE_INTEGER;
  };

  const dueCards = await CardState.find({
    userId,
    $or: [
      { nextReviewAt: { $type: 'date', $lte: asOf } },
      {
        $and: [
          {
            $or: [
              { nextReviewAt: null },
              { nextReviewAt: { $exists: false } },
            ],
          },
          { nextReview: { $type: 'date', $lte: asOf } },
        ],
      },
    ],
  })
    .sort({ nextReviewAt: 1, nextReview: 1 })
    .limit(queryLimit)
    .lean();

  dueCards.sort((a, b) => effectiveDueTime(a) - effectiveDueTime(b));

  if (!dueCards.length) {
    return { cards: [], count: 0 };
  }

  const wordIds = dueCards.map((card) => card.wordId);
  const words = await Word.find({ _id: { $in: wordIds } }).lean();
  const wordById = new Map((Array.isArray(words) ? words : []).map((word) => [String(word._id), word]));
  const deckFilter = options.deckId ? String(options.deckId) : '';

  const cards = [];
  for (const cardState of dueCards) {
    const word = wordById.get(String(cardState.wordId));
    if (!word) continue;
    if (deckFilter && String(word.deckId || '') !== deckFilter) continue;

    cards.push({
      ...word,
      cardState: {
        stability: Number(cardState?.stability || 0),
        difficulty: Number(cardState?.difficulty || 0),
        easeFactor: Number(cardState?.easeFactor || 2.5),
        reps: Math.max(0, Number(cardState?.reps || 0)),
        repetitionCount: Math.max(0, Number(cardState?.repetitionCount || cardState?.reps || 0)),
        lapses: Math.max(0, Number(cardState?.lapses || 0)),
        state: String(cardState?.state || 'new'),
        nextReviewAt: cardState?.nextReviewAt || cardState?.nextReview || null,
      },
    });

    if (cards.length >= limit) break;
  }

  return {
    cards,
    count: cards.length,
  };
}

function cleanupDiagnosticSessions() {
  const now = Date.now();
  for (const [token, session] of diagnosticSessions.entries()) {
    if (!session || (now - Number(session.createdAt || 0)) > DIAGNOSTIC_SESSION_TTL_MS) {
      diagnosticSessions.delete(token);
    }
  }
}

function assignTargetLevel(accuracyPct, avgLatencyMs) {
  const accuracy = clampNumber(accuracyPct, 0, 100, 0);
  const latency = Math.max(0, Number(avgLatencyMs || 0));

  if (accuracy < 50 || latency > 14000) return { level: 'A1', minDifficulty: 1, maxDifficulty: 2 };
  if (accuracy < 65 || latency > 11000) return { level: 'A2', minDifficulty: 2, maxDifficulty: 3 };
  if (accuracy < 80 || latency > 8500) return { level: 'B1', minDifficulty: 3, maxDifficulty: 4 };
  if (accuracy < 90 || latency > 6500) return { level: 'B2', minDifficulty: 3, maxDifficulty: 5 };
  if (accuracy < 96) return { level: 'C1', minDifficulty: 4, maxDifficulty: 5 };
  return { level: 'C2', minDifficulty: 5, maxDifficulty: 5 };
}

function computeAbilityScore(accuracyPct, avgLatencyMs) {
  const accuracy = clampNumber(accuracyPct, 0, 100, 0);
  const latencyPenalty = clampNumber((Number(avgLatencyMs || 0) - 3000) / 120, 0, 35, 0);
  const score = Math.max(0, Math.min(100, Math.round(accuracy - latencyPenalty + 8)));
  return score;
}

function buildAbilityScoredPlacement(scoredResponses) {
  const responses = Array.isArray(scoredResponses) ? scoredResponses : [];
  const workingState = {
    adaptiveProfile: {
      targetLevel: 'A1',
      abilityScore: 35,
      difficultyBand: { min: 1, max: 2 },
      behaviorSignals: { baselineLatencyMs: 2200 },
    },
  };

  responses.forEach((entry) => {
    const itemDifficultyScore = normalizeItemDifficulty(entry?.difficulty || 3);
    updateAbilityEstimate(workingState, {
      correctness: entry?.isCorrect === true,
      itemDifficulty: itemDifficultyScore,
      learningRate: 0.16,
    }, Number(entry?.responseTimeMs || 0));
  });

  const abilityScore = clampNumber(workingState?.adaptiveProfile?.abilityScore, 0, 100, 35);
  const targetLevel = inferTargetLevelFromAbilityScore(abilityScore);
  const difficultyBand = difficultyBandFromAbilityScore(abilityScore);

  return {
    abilityScore,
    targetLevel,
    difficultyBand,
  };
}

async function resolveDiagnosticWordOwnerIds(userId) {
  if (GLOBAL_WORD_SCOPE) {
    return ['*'];
  }

  if (!isDbConnected()) {
    const user = devStore.findUserById(userId);
    if (!user) return [];
    const role = String(user.role || 'student').toLowerCase();
    if (role === 'student') {
      const linkedCode = String(user.linkedCreatorCode || '').trim().toUpperCase();
      if (!linkedCode) return [];
      const linkedCreator = devStore.listUsers().find((entry) => String(entry.creatorCode || '').trim().toUpperCase() === linkedCode);
      return linkedCreator ? [String(linkedCreator._id)] : [];
    }
    return [String(user._id)];
  }

  const user = await User.findById(userId).select('role linkedCreatorCode').lean();
  if (!user) return [];
  if (String(user.role || 'student').toLowerCase() === 'student') {
    const linkedCode = String(user.linkedCreatorCode || '').trim().toUpperCase();
    if (!linkedCode) return [];
    const creator = await User.findOne({ creatorCode: linkedCode }).select('_id').lean();
    return creator ? [String(creator._id)] : [];
  }
  return [String(user._id)];
}

async function readDiagnosticWords(ownerIds) {
  const owners = Array.isArray(ownerIds) ? ownerIds.map((id) => String(id)).filter(Boolean) : [];
  if (!owners.length) return [];
  const useGlobal = owners.includes('*');

  if (!isDbConnected()) {
    const store = devStore.readStore();
    const words = Array.isArray(store.words) ? store.words : [];
    return useGlobal ? words : words.filter((word) => owners.includes(String(word.userId)));
  }

  const query = useGlobal ? {} : { userId: { $in: owners } };
  const docs = await Word.find(query)
    .select('_id word definition difficulty domain targetScoreRange')
    .lean();
  return docs || [];
}

function buildDiagnosticQuestions(words, count) {
  const prepared = (Array.isArray(words) ? words : [])
    .map((w) => ({
      id: String(w._id || ''),
      word: String(w.word || '').trim(),
      definition: String(w.definition || '').trim(),
      difficulty: normalizeWordDifficulty(w.difficulty),
      domain: String(w.domain || 'general').trim().toLowerCase() || 'general',
      targetScoreRange: String(w.targetScoreRange || '500-600').trim() || '500-600',
    }))
    .filter((w) => w.id && w.word && w.definition);

  const desiredCount = Math.max(1, Math.min(count, prepared.length));
  const sortedByDifficulty = prepared.slice().sort((a, b) => a.difficulty - b.difficulty);
  const selected = [];
  if (sortedByDifficulty.length <= desiredCount) {
    selected.push(...shuffleArray(sortedByDifficulty));
  } else {
    for (let i = 0; i < desiredCount; i += 1) {
      const idx = Math.min(sortedByDifficulty.length - 1, Math.floor((i * sortedByDifficulty.length) / desiredCount));
      selected.push(sortedByDifficulty[idx]);
    }
  }

  function pickDistractors(item, field) {
    const sameDifficulty = prepared.filter((candidate) => candidate.id !== item.id && Math.abs(candidate.difficulty - item.difficulty) <= 1);
    const sameDomain = prepared.filter((candidate) => candidate.id !== item.id && candidate.domain === item.domain);
    const pool = shuffleArray([...sameDifficulty, ...sameDomain, ...prepared.filter((candidate) => candidate.id !== item.id)]);
    const seen = new Set();
    const values = [];
    for (const candidate of pool) {
      const value = String(candidate[field] || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
      if (values.length >= 3) break;
    }
    return values;
  }

  return selected.map((item, index) => {
    const reverse = index % 2 === 1;
    const prompt = reverse ? item.word : item.definition;
    const answer = reverse ? item.definition : item.word;
    const optionField = reverse ? 'definition' : 'word';
    const distractors = pickDistractors(item, optionField);
    const options = shuffleArray([answer, ...distractors]);
    const minOptions = options.length >= 2 ? options : [answer, answer + ' (alt)'];

    return {
      questionId: 'dq_' + (index + 1),
      wordId: item.id,
      prompt,
      direction: reverse ? 'word_to_definition' : 'definition_to_word',
      options: minOptions,
      answer,
      meta: {
        difficulty: item.difficulty,
        domain: item.domain,
        targetScoreRange: item.targetScoreRange,
      },
    };
  });
}

async function buildDiagnosticSet(userId, count) {
  const ownerIds = await resolveDiagnosticWordOwnerIds(userId);
  const words = await readDiagnosticWords(ownerIds);
  const questions = buildDiagnosticQuestions(words, count);
  return {
    ownerIds,
    totalPool: words.length,
    questions,
  };
}

function scoreDiagnostic(responses, questions) {
  const inputResponses = Array.isArray(responses) ? responses : [];
  const inputQuestions = Array.isArray(questions) ? questions : [];
  const questionMap = new Map(inputQuestions.map((q) => [String(q.questionId), q]));

  let attempts = 0;
  let correct = 0;
  let latencySum = 0;
  const scoredResponses = [];

  inputResponses.forEach((item) => {
    const questionId = String(item && item.questionId ? item.questionId : '').trim();
    const answer = String(item && item.answer ? item.answer : '').trim();
    const latencyMs = Math.max(0, Number(item && item.responseTimeMs ? item.responseTimeMs : 0));
    const question = questionMap.get(questionId);
    if (!question) return;

    const isCorrect = answer.toLowerCase() === String(question.answer || '').toLowerCase();
    attempts += 1;
    if (isCorrect) correct += 1;
    latencySum += latencyMs;

    scoredResponses.push({
      questionId,
      wordId: question.wordId,
      isCorrect,
      responseTimeMs: latencyMs,
      difficulty: question.meta && question.meta.difficulty ? question.meta.difficulty : 3,
    });
  });

  const accuracy = attempts ? Number(((correct / attempts) * 100).toFixed(2)) : 0;
  const averageLatencyMs = attempts ? Number((latencySum / attempts).toFixed(2)) : 0;

  return {
    attempts,
    correct,
    accuracy,
    averageLatencyMs,
    scoredResponses,
  };
}

async function saveDiagnosticResult(userId, payload) {
  if (!isDbConnected()) {
    const existing = devStore.getProgressByUser(userId) || {
      userId,
      totalXP: 0,
      streak: 0,
      longestStreak: 0,
      lessonsCompleted: 0,
      wordsLearned: 0,
      accuracy: 0,
      totalStudyTime: 0,
      completedLessons: [],
      dailyHistory: [],
      lastActivityDate: new Date().toISOString(),
    };
    existing.adaptiveProfile = payload;
    devStore.saveProgress(userId, existing);
    return;
  }

  let progress = await Progress.findOne({ userId });
  if (!progress) {
    progress = new Progress({ userId });
  }
  progress.adaptiveProfile = payload;
  await progress.save();
}

router.use(auth);

// GET /api/study/diagnostic/start - Build initial diagnostic assessment set
router.get('/diagnostic/start', async (req, res) => {
  try {
    cleanupDiagnosticSessions();

    const count = clampNumber(req.query.count, 8, 40, 12);
    const diagnosticSet = await buildDiagnosticSet(req.user.id, count);
    const questions = Array.isArray(diagnosticSet.questions) ? diagnosticSet.questions : [];

    if (!diagnosticSet.totalPool) {
      return res.status(400).json({ message: 'No vocabulary available for diagnostic. Add words first.' });
    }

    if (!questions.length) {
      return res.status(400).json({ message: 'Not enough valid words for diagnostic.' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    diagnosticSessions.set(token, {
      userId: String(req.user.id),
      createdAt: Date.now(),
      questions,
    });

    return res.json({
      diagnosticToken: token,
      generatedAt: new Date().toISOString(),
      questionCount: questions.length,
      questions: questions.map((q) => ({
        questionId: q.questionId,
        wordId: q.wordId,
        prompt: q.prompt,
        direction: q.direction,
        options: q.options,
        meta: q.meta,
      })),
    });
  } catch (err) {
    console.error('Diagnostic start failed:', err);
    return res.status(500).json({ message: 'Failed to generate diagnostic assessment.' });
  }
});

// POST /api/study/diagnostic/submit - Score diagnostic and assign target level
router.post('/diagnostic/submit', async (req, res) => {
  try {
    cleanupDiagnosticSessions();

    const token = String(req.body && req.body.diagnosticToken ? req.body.diagnosticToken : '').trim();
    const responses = Array.isArray(req.body && req.body.responses) ? req.body.responses : [];
    if (!token) {
      return res.status(400).json({ message: 'diagnosticToken is required.' });
    }
    if (!responses.length) {
      return res.status(400).json({ message: 'responses are required.' });
    }

    const session = diagnosticSessions.get(token);
    if (!session || String(session.userId) !== String(req.user.id)) {
      return res.status(404).json({ message: 'Diagnostic session not found or expired.' });
    }

    const scored = scoreDiagnostic(responses, session.questions);
    const { attempts, correct, accuracy, averageLatencyMs } = scored;

    if (!attempts) {
      return res.status(400).json({ message: 'No valid diagnostic responses were submitted.' });
    }

    const placement = buildAbilityScoredPlacement(scored.scoredResponses);
    const fallbackLevel = assignTargetLevel(accuracy, averageLatencyMs);
    const targetLevel = placement?.targetLevel || fallbackLevel.level;
    const abilityScore = Number.isFinite(Number(placement?.abilityScore))
      ? Number(placement.abilityScore)
      : computeAbilityScore(accuracy, averageLatencyMs);
    const difficultyBand = placement?.difficultyBand || {
      min: fallbackLevel.minDifficulty,
      max: fallbackLevel.maxDifficulty,
    };

    const adaptiveProfile = {
      targetLevel,
      abilityScore,
      difficultyBand,
      diagnostic: {
        completedAt: new Date().toISOString(),
        attempts,
        correct,
        accuracy,
        averageLatencyMs,
        sessionToken: token,
      },
    };

    await saveDiagnosticResult(req.user.id, adaptiveProfile);
    diagnosticSessions.delete(token);

    return res.json({
      message: 'Diagnostic submitted successfully.',
      diagnostic: {
        attempts,
        correct,
        accuracy,
        averageLatencyMs,
      },
      targetLevel: adaptiveProfile.targetLevel,
      abilityScore: adaptiveProfile.abilityScore,
      difficultyBand: adaptiveProfile.difficultyBand,
      scoredResponses: scored.scoredResponses,
    });
  } catch (err) {
    console.error('Diagnostic submit failed:', err);
    return res.status(500).json({ message: 'Failed to score diagnostic assessment.' });
  }
});

// POST /api/study/session - Create study session
router.post('/session', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { wordIds, mode } = req.body;
    if (!wordIds || !Array.isArray(wordIds) || wordIds.length === 0) {
      return res.status(400).json({ message: 'Word IDs and mode are required.' });
    }
    if (!['flashcard', 'test', 'learn', 'match', 'write', 'live'].includes(mode)) {
      return res.status(400).json({ message: 'Invalid study mode.' });
    }

    const session = new StudySession({
      userId: req.user.id,
      wordIds,
      mode,
      responses: [],
    });

    await session.save();
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create study session.' });
  }
});

// POST /api/study/session/:id/complete - Complete study session
router.post('/session/:id/complete', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { correctCount, totalCount, score, duration, responses } = req.body;
    if (typeof correctCount !== 'number' || typeof totalCount !== 'number') {
      return res.status(400).json({ message: 'correctCount and totalCount are required.' });
    }

    const session = await StudySession.findById(req.params.id);
    if (!session || session.userId.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Session not found.' });
    }

    // Update session
    session.correctCount = correctCount;
    session.totalCount = totalCount;
    session.score = score || Math.round((correctCount / totalCount) * 100);
    session.duration = duration || 0;
    session.responses = responses || [];
    await session.save();

    // Update user stats
    let userStats = await UserStats.findOne({ userId: req.user.id });
    if (!userStats) {
      userStats = new UserStats({ userId: req.user.id });
    }

    // Calculate XP
    const xpEarned = gamification.calculateSessionXP(session.toObject());
    userStats.totalXP += xpEarned;
    userStats.totalSessionsCompleted += 1;
    userStats.totalStudyTime += duration || 0;

    // Update mode stats
    const modeStats = userStats.studyModeStats[session.mode];
    if (modeStats) {
      modeStats.sessions += 1;
      modeStats.score = Math.round((modeStats.score * (modeStats.sessions - 1) + session.score) / modeStats.sessions);
    }

    // Update level
    userStats.level = gamification.calculateLevel(userStats.totalXP);

    // Update streak
    const newStreak = gamification.updateStreak(userStats.lastStudyDate, userStats.currentStreak || 0);
    if (newStreak > (userStats.currentStreak || 0)) {
      userStats.currentStreak = newStreak;
    }
    if (newStreak > (userStats.longestStreak || 0)) {
      userStats.longestStreak = newStreak;
    }
    userStats.lastStudyDate = new Date();

    // Track per-day session volume for daily badge logic.
    const dailySessionCount = gamification.recordSessionDailyCount(
      userStats,
      session.updatedAt || session.createdAt || new Date()
    );

    // Check badge completion
    const newBadges = gamification.checkBadgeCompletion(userStats, {
      ...session.toObject(),
      dailySessionCount,
    });
    userStats.badges = [...new Set([...userStats.badges, ...newBadges])];

    await userStats.save();

    // Update card states with FSRS scheduling
    if (responses && responses.length > 0) {
      for (const response of responses) {
        const responseCorrect = String(response?.correct).toLowerCase() === 'true' || response?.correct === true;
        let cardState = await CardState.findOne({
          userId: req.user.id,
          wordId: response.wordId,
        });

        if (!cardState) {
          cardState = new CardState({
            userId: req.user.id,
            wordId: response.wordId,
          });
        }

        // Use explicit scheduling helper to keep review state fields consistent.
        const grade = resolveReviewGrade(response);
        scheduleNextReview(cardState, grade);

        await cardState.save();

        const responseLatency = Math.max(0, Number(response?.responseTimeMs || response?.latencyMs || 0));
        const word = await Word.findById(response.wordId).exec();
        if (word) {
          word.adaptiveMetrics = word.adaptiveMetrics || {};
          const masteryUpdate = updateMasteryStatus({
            ...word.toObject(),
            masterySession: {
              sessionId: String(session._id),
              sessionAt: session.updatedAt || session.createdAt || new Date(),
              correctCount: responseCorrect ? 1 : 0,
              totalCount: 1,
              accuracy: responseCorrect ? 100 : 0,
              mode: session.mode,
              responseTimeMs: responseLatency,
            },
          });

          word.adaptiveMetrics = {
            ...word.adaptiveMetrics,
            masteryHistory: masteryUpdate?.history || word.adaptiveMetrics.masteryHistory || [],
            masteryStatus: masteryUpdate?.masteryStatus || word.adaptiveMetrics.masteryStatus || 'locked',
            masteryUpdatedAt: masteryUpdate?.history?.length ? new Date() : word.adaptiveMetrics.masteryUpdatedAt || null,
            masteryRecentAccuracy: pickNumber(masteryUpdate?.recentAccuracy, pickNumber(word.adaptiveMetrics.masteryRecentAccuracy, 0)),
            masterySessionCount: pickNumber(masteryUpdate?.history?.length, pickNumber(word.adaptiveMetrics.masterySessionCount, 0)),
            masteryQualifyingSessions: pickNumber(masteryUpdate?.qualifyingSessions, pickNumber(word.adaptiveMetrics.masteryQualifyingSessions, 0)),
            masteryDistinctDays: pickNumber(masteryUpdate?.uniqueDays, pickNumber(word.adaptiveMetrics.masteryDistinctDays, 0)),
            masterySpreadDays: pickNumber(masteryUpdate?.spreadDays, pickNumber(word.adaptiveMetrics.masterySpreadDays, 0)),
            masteredAt: masteryUpdate?.mastered ? (word.adaptiveMetrics.masteredAt || new Date()) : word.adaptiveMetrics.masteredAt || null,
          };
          if (masteryUpdate?.mastered) {
            word.learningStatus = 'mastered';
          } else if (String(word.learningStatus || '').toLowerCase() !== 'mastered') {
            word.learningStatus = masteryUpdate?.qualifyingSessions > 0 ? 'in_progress' : 'locked';
          }

          await word.save();
        }

        await Word.updateOne(
          { _id: response.wordId },
          {
            $set: {
              nextReviewAt: cardState.nextReviewAt || cardState.nextReview,
              'adaptiveMetrics.dueAt': cardState.nextReviewAt || cardState.nextReview,
            },
          }
        );
      }

      // Count mastered words
      const masteredCards = await CardState.countDocuments({
        userId: req.user.id,
        state: 'review',
        stability: { $gte: 10 },
      });
      userStats.totalWordsLearned = masteredCards;

      // Calculate average retention
      const allCards = await CardState.find({ userId: req.user.id });
      userStats.averageRetention = fsrsScheduler.calculateRetention(allCards);

      await userStats.save();
    }

    res.json({
      session,
      xpEarned,
      userStats: {
        totalXP: userStats.totalXP,
        level: userStats.level,
        streak: userStats.currentStreak,
        badges: newBadges,
      },
    });
  } catch (err) {
    console.error('Session completion error:', err);
    res.status(500).json({ message: 'Failed to complete session.' });
  }
});

// GET /api/study/due-cards - Get cards due for review (FSRS)
router.get('/due-cards', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { deckId } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const queued = await queueDueCards(req.user.id, new Date(), { deckId, limit });
    res.json(queued);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch due cards.' });
  }
});

// GET /api/study/stats - Get learning statistics
router.get('/stats', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const userStats = await UserStats.findOne({ userId: req.user.id });
    if (!userStats) {
      return res.json({
        totalXP: 0,
        level: 1,
        streak: 0,
        badges: [],
        totalWordsLearned: 0,
        averageRetention: 0,
      });
    }

    res.json(userStats);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch stats.' });
  }
});

// GET /api/study/leaderboard - Top learners
router.get('/leaderboard', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const leaderboard = await UserStats.find()
      .sort({ totalXP: -1 })
      .limit(limit)
      .populate('userId', 'name avatar');

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch leaderboard.' });
  }
});

router.__internals = {
  normalizeGrade,
  resolveReviewGrade,
  markLapse,
  scheduleNextReview,
  queueDueCards,
  buildDiagnosticSet,
  scoreDiagnostic,
  assignTargetLevel,
};

module.exports = router;
