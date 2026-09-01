const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Progress = require('../models/Progress');
const User = require('../models/User');
const Word = require('../models/Word');
const CardState = require('../models/CardState');
const fsrsScheduler = require('../utils/fsrsScheduler');
const auth = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');
const { createCache, clearByPrefix, withCache } = require('../services/cacheService');
const { buildModeAccess, resolveSafeMode } = require('../services/adaptiveModePolicy');
const { saveProgressForUser } = require('../services/progressPersistence');
const {
  inferTargetLevelFromAbilityScore,
  difficultyBandFromAbilityScore,
  normalizeItemDifficulty,
  expectedSuccess,
  updateAbilityEstimate,
  updateItemDifficulty,
} = require('../services/irtLite');
const { canUnlockNextModule } = require('../services/masteryTracking');
const { buildAdaptiveQueue } = require('../services/adaptiveQueueMix');
const { detectSubtopicStruggle } = require('../services/subtopicStruggle');
const { buildRemediationPack } = require('../services/remediationPack');
const {
  classifyAttemptBehavior,
  computeConfidenceScore,
  normalizeCorrectness,
  updateBehaviorSignals,
} = require('../services/behaviorAnalytics');
const wordsRoute = require('./words');
const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';
const progressCache = createCache();

const ACHIEVEMENT_RULES = [
  { id: 'first_session', title: 'First Step', description: 'Complete your first learning session.', category: 'sessions', threshold: 1 },
  { id: 'streak_3', title: 'Consistency Start', description: 'Reach a 3-day streak.', category: 'streak', threshold: 3 },
  { id: 'streak_7', title: 'Week Warrior', description: 'Reach a 7-day streak.', category: 'streak', threshold: 7 },
  { id: 'xp_500', title: 'XP Builder', description: 'Earn 500 total XP.', category: 'xp', threshold: 500 },
  { id: 'xp_2000', title: 'XP Master', description: 'Earn 2,000 total XP.', category: 'xp', threshold: 2000 },
  { id: 'words_50', title: 'Word Collector', description: 'Learn 50 words.', category: 'words', threshold: 50 },
  { id: 'words_250', title: 'Lexicon Builder', description: 'Learn 250 words.', category: 'words', threshold: 250 },
  { id: 'lessons_25', title: 'Practice Habit', description: 'Complete 25 sessions.', category: 'lessons', threshold: 25 },
  {
    id: 'accuracy_85',
    title: 'Precision Pro',
    description: 'Maintain at least 85% weighted average accuracy across at least 10 sessions.',
    category: 'accuracy_weighted',
    threshold: 85,
    minSessions: 10,
  },
];

function createEmptyProgress(userId) {
  return {
    userId,
    totalXP: 0,
    streak: 0,
    longestStreak: 0,
    lessonsCompleted: 0,
    wordsLearned: 0,
    accuracy: 0,
    totalStudyTime: 0,
    adaptiveProfile: {
      targetLevel: 'A1',
      abilityScore: 0,
      difficultyBand: { min: 1, max: 2 },
      diagnostic: {
        completedAt: null,
        attempts: 0,
        correct: 0,
        accuracy: 0,
        averageLatencyMs: 0,
        sessionToken: null,
      },
      behaviorSignals: {
        baselineLatencyMs: 2200,
        confidenceScore: 0.6,
        fastGuessRate: 0,
        slowStruggleRate: 0,
        recentBehaviors: [],
        updatedAt: null,
      },
      masteryGates: {
        flashcards: { unlocked: true, reason: 'Available by default.', subSkills: {}, requiredSubSkills: [], lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
        matching: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', subSkills: {}, requiredSubSkills: [], lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
        quiz: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', subSkills: {}, requiredSubSkills: [], lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
        spelling: { unlocked: false, reason: 'Improve confidence or accuracy to unlock.', subSkills: {}, requiredSubSkills: [], lastUnlockedAt: null, lastLockedAt: null, transitionCount: 0, transitionHistory: [] },
      },
      remediation: {
        active: false,
        reason: '',
        focusModes: [],
        recommendedWordIds: [],
        updatedAt: null,
      },
    },
    completedLessons: [],
    dailyHistory: [],
    adaptiveQueue: {
      generatedAt: null,
      targetWords: 0,
      dueReviewCount: 0,
      remediationCount: 0,
      mix: {
        totalRequested: 0,
        targetCounts: { current: 0, stretch: 0, review: 0 },
        counts: { current: 0, stretch: 0, review: 0 },
        ratios: { current: 0.7, stretch: 0.2, review: 0.1 },
      },
      queuePreview: [],
      activeQueue: {
        planId: null,
        queueId: null,
        status: null,
        version: 1,
        createdAt: null,
        expiresAt: null,
        completedAt: null,
        abandonedAt: null,
        settings: {
          minutes: 20,
          wordCount: 16,
          targetLevel: 'AUTO',
          hearts: 5,
          difficultyBand: { min: 1, max: 5, label: 'Auto' },
        },
        cursor: {
          nextIndex: 0,
          completedCount: 0,
        },
        modeProgress: {
          flashcards: 0,
          quiz: 0,
          matching: 0,
          spelling: 0,
        },
        items: [],
        attemptLedger: [],
      },
    },
    lastActivityDate: new Date(),
  };
}

function shouldRequeueItem(correctness, behavior, requeueCount) {
  const isCorrect = normalizeCorrectness(correctness);
  const count = Math.max(0, Number(requeueCount || 0));
  if (count >= 3) return false;
  if (!isCorrect) return true;
  return behavior === 'slow_but_correct';
}

function computeRetryDelaySlots(correctness, requeueCount) {
  const isCorrect = normalizeCorrectness(correctness);
  const count = Math.max(0, Number(requeueCount || 0));
  // Wrong attempts reappear with expanding spacing: 1, 3, 5, ...
  // Slow-but-correct retries are slightly more delayed: 2, 4, 6, ...
  return (isCorrect ? 2 : 1) + (count * 2);
}

function buildRequeueItem(originalItem) {
  return {
    queueItemId: crypto.randomBytes(6).toString('hex'),
    position: 0,
    wordId: String(originalItem.wordId || ''),
    word: String(originalItem.word || ''),
    definition: String(originalItem.definition || ''),
    difficulty: asBoundedNumber(originalItem.difficulty, 1, 5, 3),
    source: String(originalItem.source || 'general'),
    status: 'pending',
    attempts: 0,
    correctAttempts: 0,
    latencyMsAvg: 0,
    lastLatencyMs: 0,
    behavior: null,
    requeueCount: Math.max(0, Number(originalItem.requeueCount || 0)) + 1,
    lastMode: null,
    lastAttemptAt: null,
  };
}

function normalizeQueueItemPositions(items) {
  return Array.isArray(items)
    ? items.map((item, idx) => ({ ...item, position: idx }))
    : [];
}

function computeRetryInsertIndex(activeItems, nextIndex, delaySlots) {
  const insertAfter = Math.max(nextIndex + delaySlots, nextIndex + 1);
  return Math.min(activeItems.length, insertAfter);
}

const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;

function computeWordReviewInterval(correctness, reviewedCount, difficulty) {
  const safeDifficulty = Math.max(1, Math.min(5, Number(difficulty || 3)));
  const base = Math.max(1, Math.round((Number(reviewedCount || 0) || 1) * 2 + safeDifficulty));
  return correctness ? Math.min(30, base) : 1;
}

async function persistSpacedRepetition(userId, wordId, correctness, latencyMs, useDb, populationStats = {}) {
  if (!wordId) return null;
  const now = new Date();
  const isCorrect = normalizeCorrectness(correctness);
  const grade = isCorrect ? '3' : '1';

  if (!useDb) {
    const word = GLOBAL_WORD_SCOPE
      ? devStore.findWordById(wordId)
      : devStore.findWordByIdForUser(wordId, userId);
    if (!word) return null;

    const reviewed = Math.max(0, Number(word.timesReviewed || 0)) + 1;
    const correct = Math.max(0, Number(word.timesCorrect || 0)) + (isCorrect ? 1 : 0);
    const prevAvg = Number(word.adaptiveMetrics?.averageLatencyMs || 0);
    const attempts = Math.max(0, Number(word.adaptiveMetrics?.attempts || 0)) + 1;
    const adaptiveCorrect = Math.max(0, Number(word.adaptiveMetrics?.correct || 0)) + (isCorrect ? 1 : 0);
    const adaptiveIncorrect = Math.max(0, Number(word.adaptiveMetrics?.incorrect || 0)) + (isCorrect ? 0 : 1);
    const averageLatencyMs = prevAvg === 0
      ? Number(latencyMs || 0)
      : Math.round(((prevAvg * (attempts - 1)) + Number(latencyMs || 0)) / attempts);
    const effectiveCorrectRate = Number.isFinite(Number(populationStats?.correctRate))
      ? Number(populationStats.correctRate)
      : (attempts > 0 ? adaptiveCorrect / attempts : (isCorrect ? 1 : 0));
    const itemDifficultyUpdate = updateItemDifficulty(word, isCorrect, {
      correctRate: effectiveCorrectRate,
      sampleSize: Number(populationStats?.sampleSize || attempts),
    });
    const intervalDays = computeWordReviewInterval(isCorrect, reviewed, word.difficulty);
    const nextReviewAt = new Date(Date.now() + intervalDays * REVIEW_DAY_MS).toISOString();
    const updatedMetrics = {
      attempts,
      correct: adaptiveCorrect,
      incorrect: adaptiveIncorrect,
      lastLatencyMs: Number(latencyMs || 0),
      averageLatencyMs,
      dueAt: nextReviewAt,
      lastAttemptAt: now.toISOString(),
      itemDifficulty: Number(word?.adaptiveMetrics?.itemDifficulty || itemDifficultyUpdate?.nextDifficulty || normalizeItemDifficulty(word.difficulty)),
    };
    const payload = {
      timesReviewed: reviewed,
      timesCorrect: correct,
      lastReviewedAt: now.toISOString(),
      nextReviewAt,
      adaptiveMetrics: {
        ...(word.adaptiveMetrics || {}),
        ...updatedMetrics,
      },
    };
    if (GLOBAL_WORD_SCOPE) {
      devStore.updateWordGlobal(wordId, payload);
    } else {
      devStore.updateWord(wordId, userId, payload);
    }
    return {
      ...payload,
      difficulty: asBoundedNumber(payload.difficulty, 1, 5, 3),
      itemDifficulty: asBoundedNumber(payload?.adaptiveMetrics?.itemDifficulty, 0, 100, normalizeItemDifficulty(payload.difficulty)),
    };
  }

  const word = await Word.findById(wordId).exec();
  if (!word) return null;
  word.timesReviewed = Math.max(0, Number(word.timesReviewed || 0)) + 1;
  if (isCorrect) word.timesCorrect = Math.max(0, Number(word.timesCorrect || 0)) + 1;
  word.lastReviewedAt = now;
  word.adaptiveMetrics = word.adaptiveMetrics || {};
  word.adaptiveMetrics.attempts = Math.max(0, Number(word.adaptiveMetrics.attempts || 0)) + 1;
  word.adaptiveMetrics.correct = Math.max(0, Number(word.adaptiveMetrics.correct || 0)) + (isCorrect ? 1 : 0);
  word.adaptiveMetrics.incorrect = Math.max(0, Number(word.adaptiveMetrics.incorrect || 0)) + (isCorrect ? 0 : 1);
  const prevAvg = Number(word.adaptiveMetrics.averageLatencyMs || 0);
  word.adaptiveMetrics.lastLatencyMs = Number(latencyMs || 0);
  word.adaptiveMetrics.averageLatencyMs = prevAvg === 0
    ? Number(latencyMs || 0)
    : Math.round(((prevAvg * (word.adaptiveMetrics.attempts - 1)) + Number(latencyMs || 0)) / word.adaptiveMetrics.attempts);
  const effectiveCorrectRate = Number.isFinite(Number(populationStats?.correctRate))
    ? Number(populationStats.correctRate)
    : (word.adaptiveMetrics.attempts > 0
      ? word.adaptiveMetrics.correct / word.adaptiveMetrics.attempts
      : (isCorrect ? 1 : 0));
  updateItemDifficulty(word, isCorrect, {
    correctRate: effectiveCorrectRate,
    sampleSize: Number(populationStats?.sampleSize || word.adaptiveMetrics.attempts),
  });

  const fsrsWordCount = Math.max(0, Number(word.timesReviewed || 0));
  const fsrsUpdate = fsrsScheduler.calculateNextInterval(
    0,
    0.5,
    grade,
    'new'
  );
  let cardState = await CardState.findOne({ userId, wordId }).exec();
  if (!cardState) {
    cardState = new CardState({ userId, wordId });
  }
  const nextFsrs = fsrsScheduler.calculateNextInterval(
    cardState.stability,
    cardState.difficulty,
    grade,
    cardState.state
  );
  cardState.stability = nextFsrs.newStability;
  cardState.difficulty = nextFsrs.newDifficulty;
  cardState.state = nextFsrs.state;
  cardState.nextReview = new Date(Date.now() + nextFsrs.nextInterval * REVIEW_DAY_MS);
  cardState.lastReview = now;
  cardState.reps = Math.max(0, Number(cardState.reps || 0)) + 1;
  if (!isCorrect) cardState.lapses = Math.max(0, Number(cardState.lapses || 0)) + 1;
  if (isCorrect) cardState.totalCorrect = Math.max(0, Number(cardState.totalCorrect || 0)) + 1;
  cardState.totalAttempts = Math.max(0, Number(cardState.totalAttempts || 0)) + 1;
  await cardState.save();
  word.nextReviewAt = cardState.nextReview;
  word.adaptiveMetrics.dueAt = cardState.nextReview;
  await word.save();
  return {
    word,
    cardState,
    difficulty: asBoundedNumber(word.difficulty, 1, 5, 3),
    itemDifficulty: asBoundedNumber(word?.adaptiveMetrics?.itemDifficulty, 0, 100, normalizeItemDifficulty(word.difficulty)),
  };
}

function computeLiveQueueItems(items) {
  return Array.isArray(items) ? normalizeQueueItemPositions(items) : [];
}

function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function buildDailyPlanFromProfile(userState, prefs = {}) {
  const snapshot = normalizeProgressSnapshot(userState, userState?.userId || '');
  const minutes = clampNumber(prefs.minutes, 10, 120, 20);
  const requestedWordCount = clampNumber(prefs.wordCount, 5, 60, Math.max(8, Math.round(minutes * 0.8)));
  const hearts = clampNumber(prefs.hearts, 0, 5, 5);
  const behaviorSignals = snapshot.adaptiveProfile?.behaviorSignals || createEmptyProgress(snapshot.userId).adaptiveProfile.behaviorSignals;
  const dueReviews = asNonNegativeNumber(prefs.dueReviews, 0);
  const lowHearts = hearts <= 2;
  const confidencePenalty = behaviorSignals.confidenceScore < 0.42 ? 3 : 0;
  const strugglePenalty = behaviorSignals.slowStruggleRate > 0.22 ? 2 : 0;
  const fastGuessPenalty = behaviorSignals.fastGuessRate > 0.2 ? 1 : 0;
  const heartPenalty = lowHearts ? 3 : 0;
  const riskPenalty = (behaviorSignals.fastGuessRate > 0.18 ? 1 : 0) + (behaviorSignals.slowStruggleRate > 0.18 ? 1 : 0);
  const finalWordCount = clampNumber(requestedWordCount - confidencePenalty - strugglePenalty - fastGuessPenalty - heartPenalty - riskPenalty, 5, 60, requestedWordCount);
  return {
    snapshot,
    prefs: { ...prefs, minutes, wordCount: requestedWordCount, hearts },
    diagnosticLevel: snapshot.adaptiveProfile.targetLevel,
    abilityScore: snapshot.adaptiveProfile.abilityScore,
    dueReviews,
    heartState: {
      count: hearts,
      lowHearts,
      recommendation: lowHearts ? 'Low hearts detected. Prioritize safer review rounds before hard testing.' : 'Hearts are healthy enough for full challenge mode.',
    },
    behaviorSignals,
    targetWordCount: finalWordCount,
    masteryProgressPct: Math.round((snapshot.adaptiveProfile.abilityScore / 100) * 100),
  };
}

function applyMasteryGates(plan) {
  const snapshot = plan?.snapshot || createEmptyProgress(plan?.userId || '').snapshot || {};
  const adaptive = snapshot?.adaptiveProfile || {};
  const diagnostic = adaptive.diagnostic || {};
  const accuracy = asBoundedNumber(snapshot.accuracy, 0, 100, 0);
  const lessons = Math.max(0, asNonNegativeNumber(snapshot.lessonsCompleted, 0));
  const confidence = clampNumber(plan?.behaviorSignals?.confidenceScore, 0, 1, 0.6);
  const fastGuessRate = clampNumber(plan?.behaviorSignals?.fastGuessRate, 0, 1, 0);
  const slowStruggleRate = clampNumber(plan?.behaviorSignals?.slowStruggleRate, 0, 1, 0);
  const diagnosticAccuracy = asBoundedNumber(diagnostic.accuracy, 0, 100, 0);
  const diagnosticAttempts = Math.max(0, asNonNegativeNumber(diagnostic.attempts, 0));
  const recentBehaviorCount = Array.isArray(plan?.behaviorSignals?.recentBehaviors) ? plan.behaviorSignals.recentBehaviors.length : 0;
  const lowHearts = !!plan?.heartState?.lowHearts;
  const existingGates = adaptive?.masteryGates && typeof adaptive.masteryGates === 'object' ? adaptive.masteryGates : {};

  const stablePerformance = accuracy >= 60 && confidence >= 0.55 && lessons >= 3 && fastGuessRate <= 0.15 && slowStruggleRate <= 0.2;
  const reviewConsistency = accuracy >= 62 && confidence >= 0.58 && lessons >= 2 && recentBehaviorCount >= 4;
  const riskyBehavior = fastGuessRate > 0.18 || slowStruggleRate > 0.18;

  function buildSubSkill(label, passed, score, threshold, reason) {
    return { label, passed, score, threshold, reason };
  }

  function buildGateEntry(previousGate, unlocked, reason, subSkills) {
    return buildTransitionedGate(previousGate, unlocked, reason, subSkills);
  }

  const flashcards = buildGateEntry(existingGates.flashcards, true, 'Flashcards stay available for stabilization and review.', {
    stability: buildSubSkill('stability', true, 1, 0, 'Always available for safe review.'),
  });

  const matchingSubSkills = {
    recall: buildSubSkill('recall', accuracy >= 58 && confidence >= 0.54, accuracy >= 58 && confidence >= 0.54 ? 1 : 0, 1, accuracy >= 58 && confidence >= 0.54 ? 'Recall is steady enough for pattern matching.' : 'Improve accuracy and confidence before moving into matching.'),
    speed: buildSubSkill('speed', fastGuessRate <= 0.16 && slowStruggleRate <= 0.2, fastGuessRate <= 0.16 && slowStruggleRate <= 0.2 ? 1 : 0, 1, fastGuessRate <= 0.16 && slowStruggleRate <= 0.2 ? 'Pace stays controlled rather than rushed or stuck.' : 'Reduce rushed guesses and repeated struggle before matching.'),
    stability: buildSubSkill('stability', stablePerformance, stablePerformance ? 1 : 0, 1, stablePerformance ? 'Recent performance is stable across sessions.' : 'Complete more sessions with steadier accuracy and lower error patterns.'),
  };
  const matchingUnlocked = matchingSubSkills.recall.passed && matchingSubSkills.speed.passed && matchingSubSkills.stability.passed && !riskyBehavior;
  const matchingReason = matchingUnlocked
    ? 'Matching is unlocked because recall, speed, and stability all look solid.'
    : riskyBehavior
      ? 'Matching stays locked while guessing or repeated struggle is still dominating recent responses.'
      : 'Matching requires steady recall, controlled pace, and repeated stability before unlocking.';
  const matching = buildGateEntry(existingGates.matching, matchingUnlocked, matchingReason, matchingSubSkills);

  const quizSubSkills = {
    recall: buildSubSkill('recall', accuracy >= 68 && confidence >= 0.62, accuracy >= 68 && confidence >= 0.62 ? 1 : 0, 1, accuracy >= 68 && confidence >= 0.62 ? 'Recall is strong enough for quiz pressure.' : 'Boost recall accuracy and confidence before quizzes.'),
    spelling: buildSubSkill('spelling', accuracy >= 70 && slowStruggleRate <= 0.15 && diagnosticAttempts >= 2, accuracy >= 70 && slowStruggleRate <= 0.15 && diagnosticAttempts >= 2 ? 1 : 0, 1, accuracy >= 70 && slowStruggleRate <= 0.15 && diagnosticAttempts >= 2 ? 'Spelling precision is consistent.' : 'Keep precision high and finish a few more rounds before quiz mode.'),
    speed: buildSubSkill('speed', fastGuessRate <= 0.12 && slowStruggleRate <= 0.16, fastGuessRate <= 0.12 && slowStruggleRate <= 0.16 ? 1 : 0, 1, fastGuessRate <= 0.12 && slowStruggleRate <= 0.16 ? 'Responses are neither rushed nor stalled.' : 'Control pacing so quiz attempts stay deliberate.'),
    stability: buildSubSkill('stability', reviewConsistency && lessons >= 4, reviewConsistency && lessons >= 4 ? 1 : 0, 1, reviewConsistency && lessons >= 4 ? 'You have shown repeated stable performance across sessions.' : 'Complete more sessions with consistent results before unlocking quizzes.'),
  };
  const quizUnlocked = !lowHearts && quizSubSkills.recall.passed && quizSubSkills.spelling.passed && quizSubSkills.speed.passed && quizSubSkills.stability.passed && !riskyBehavior;
  const quizReason = quizUnlocked
    ? 'Quiz mode is ready because recall, spelling, speed, and stability all meet the bar.'
    : lowHearts
      ? 'Recover hearts before opening quiz mode.'
      : riskyBehavior
        ? 'Quiz mode stays locked until rushed guesses and repeated struggle are both under control.'
        : 'Quiz mode needs stronger recall, spelling precision, speed control, and repeated stability.';
  const quiz = buildGateEntry(existingGates.quiz, quizUnlocked, quizReason, quizSubSkills);

  const spellingSubSkills = {
    spelling: buildSubSkill('spelling', accuracy >= 72 && diagnosticAccuracy >= 66 && slowStruggleRate <= 0.12, accuracy >= 72 && diagnosticAccuracy >= 66 && slowStruggleRate <= 0.12 ? 1 : 0, 1, accuracy >= 72 && diagnosticAccuracy >= 66 && slowStruggleRate <= 0.12 ? 'Spelling accuracy is strong and precise.' : 'Raise spelling accuracy and reduce struggle before precision mode.'),
    recall: buildSubSkill('recall', accuracy >= 70 && confidence >= 0.6, accuracy >= 70 && confidence >= 0.6 ? 1 : 0, 1, accuracy >= 70 && confidence >= 0.6 ? 'Recall is dependable enough for detailed spelling work.' : 'Improve recall accuracy and confidence before spelling mode.'),
    speed: buildSubSkill('speed', fastGuessRate <= 0.1 && slowStruggleRate <= 0.12, fastGuessRate <= 0.1 && slowStruggleRate <= 0.12 ? 1 : 0, 1, fastGuessRate <= 0.1 && slowStruggleRate <= 0.12 ? 'Pace is calm and deliberate.' : 'Avoid rushed guesses and lingering struggle before spelling mode.'),
    stability: buildSubSkill('stability', lessons >= 4 && accuracy >= 70 && confidence >= 0.6, lessons >= 4 && accuracy >= 70 && confidence >= 0.6 ? 1 : 0, 1, lessons >= 4 && accuracy >= 70 && confidence >= 0.6 ? 'Repeated performance is steady enough for precision training.' : 'Complete more stable practice sessions before precision training.'),
  };
  const spellingUnlocked = spellingSubSkills.spelling.passed && spellingSubSkills.recall.passed && spellingSubSkills.speed.passed && spellingSubSkills.stability.passed && !riskyBehavior;
  const spellingReason = spellingUnlocked
    ? 'Spelling mode is unlocked because precision, recall, speed, and stability are all strong.'
    : riskyBehavior
      ? 'Spelling mode stays locked while rushed guesses and repeated struggle are still too frequent.'
      : 'Spelling mode needs stronger precision, recall, controlled pacing, and repeated stability.';
  const spelling = buildGateEntry(existingGates.spelling, spellingUnlocked, spellingReason, spellingSubSkills);

  const gates = { flashcards, matching, quiz, spelling };
  plan.masteryGates = gates;
  plan.unlockedModes = Object.keys(gates).filter((key) => gates[key].unlocked);
  plan.lockedModes = Object.keys(gates).filter((key) => !gates[key].unlocked).map((key) => ({ mode: key, reason: gates[key].reason }));
  plan.availableModes = plan.unlockedModes;
  plan.blockedModes = plan.lockedModes;
  return plan;
}

function normalizeSubtopicLabel(value) {
  const label = String(value || '').trim().toLowerCase();
  if (!label) return null;
  if (label === 'general' || label === 'other' || label === 'misc') return null;
  return label;
}

function extractSubtopicsFromWord(word) {
  const tags = Array.isArray(word?.tags)
    ? word.tags.map((tag) => normalizeSubtopicLabel(tag)).filter(Boolean)
    : [];
  const domain = normalizeSubtopicLabel(word?.domain);
  const deck = normalizeSubtopicLabel(word?.deckName || word?.deckTitle || word?.deckId);
  const set = new Set([...tags]);
  if (domain) set.add(domain);
  if (deck && set.size < 3) set.add(deck);
  return Array.from(set).slice(0, 3);
}

function buildSubtopicPerfWindow(words = [], options = {}) {
  const maxAttemptsPerWord = Math.max(1, Math.floor(asNonNegativeNumber(options.maxAttemptsPerWord, 3)));
  const fallbackSubtopic = String(options.fallbackSubtopic || 'general').trim().toLowerCase() || 'general';
  const entries = [];

  (Array.isArray(words) ? words : []).forEach((word) => {
    const attemptsRaw = Math.max(
      asNonNegativeNumber(word?.adaptiveMetrics?.attempts, 0),
      asNonNegativeNumber(word?.timesReviewed, 0)
    );
    if (attemptsRaw <= 0) return;

    const attempts = Math.max(1, Math.min(maxAttemptsPerWord, Math.floor(attemptsRaw)));
    const correctRaw = Math.max(
      asNonNegativeNumber(word?.adaptiveMetrics?.correct, 0),
      asNonNegativeNumber(word?.timesCorrect, 0)
    );
    const correctRatio = attemptsRaw > 0 ? Math.min(1, Math.max(0, correctRaw / attemptsRaw)) : 0;
    const correctCount = Math.max(0, Math.min(attempts, Math.round(correctRatio * attempts)));
    const accuracy = attempts > 0 ? Number(((correctCount / attempts) * 100).toFixed(2)) : 0;
    const at = word?.adaptiveMetrics?.lastAttemptAt
      || word?.lastReviewedAt
      || word?.updatedAt
      || word?.createdAt
      || null;

    const detected = extractSubtopicsFromWord(word);
    const subtopics = detected.length ? detected : [fallbackSubtopic];
    subtopics.forEach((subtopic) => {
      entries.push({
        subtopic,
        totalCount: attempts,
        correctCount,
        accuracy,
        lastAttemptAt: at,
      });
    });
  });

  return entries;
}

function injectRemediationIntoPlan(plan, remediationPack, options = {}) {
  if (!plan || typeof plan !== 'object') return plan;
  const safePack = remediationPack && typeof remediationPack === 'object'
    ? remediationPack
    : {
      active: false,
      words: [],
      totalSelected: 0,
      reason: '',
    };

  plan.remediation = plan.remediation && typeof plan.remediation === 'object'
    ? plan.remediation
    : {};
  plan.remediation.remediationPack = safePack;

  if (safePack.active && options.syncActive === true) {
    plan.remediation.active = true;
    plan.remediation.status = 'active';
  }

  if (!plan.remediation.reason && safePack.reason) {
    plan.remediation.reason = safePack.reason;
  }

  return plan;
}

function applyRemediation(plan, context = {}) {
  const signals = plan.behaviorSignals || {};
  const lowAccuracy = asBoundedNumber(plan.snapshot.accuracy, 0, 100, 0) < 68;
  const struggling = signals.slowStruggleRate > 0.2 || signals.fastGuessRate > 0.18;
  const lowHearts = !!plan.heartState?.lowHearts;
  const perfWindow = Array.isArray(context?.perfWindow)
    ? context.perfWindow
    : buildSubtopicPerfWindow(context?.words || [], { maxAttemptsPerWord: 3, fallbackSubtopic: 'general' });
  const subtopicSignal = detectSubtopicStruggle(perfWindow, {
    accuracyThresholdPct: 50,
    recentWindow: 18,
    minAttempts: 4,
  });
  const subtopicStruggle = !!subtopicSignal.active;
  const active = lowAccuracy || struggling || lowHearts || subtopicStruggle;
  const focusModes = [];
  if (lowHearts) focusModes.push('flashcards');
  if (signals.slowStruggleRate > 0.2) focusModes.push('spelling');
  if (signals.fastGuessRate > 0.18) focusModes.push('matching');
  if (lowAccuracy) focusModes.push('flashcards');
  if (subtopicStruggle) focusModes.push('flashcards');

  const primary = subtopicSignal?.primarySubtopic;
  const subtopicReason = primary
    ? `Sub-topic ${primary.subtopic} dropped to ${primary.accuracyPct}% over recent attempts.`
    : '';
  const targetDifficulty = clampNumber((plan?.snapshot?.adaptiveProfile?.difficultyBand?.min || 1) - 1, 1, 5, 1);
  const remediationPack = buildRemediationPack(primary?.subtopic || null, targetDifficulty, {
    words: context?.words || [],
    maxItems: 8,
  });

  plan.remediation = {
    active,
    reason: subtopicStruggle
      ? subtopicReason
      : lowHearts
        ? 'Hearts are low, so the system is lowering risk and slowing the pace.'
        : struggling
          ? 'Recent attempts suggest guessing or repeated struggle, so remediation is active.'
          : lowAccuracy
            ? 'Accuracy is below the threshold, so the plan is prioritizing recovery.'
            : 'No remediation needed.',
    focusModes: Array.from(new Set(focusModes)).slice(0, 3),
    status: active ? 'active' : 'clear',
    subtopicStruggle,
    subtopicSignals: {
      primary: primary
        ? {
          subtopic: primary.subtopic,
          accuracyPct: primary.accuracyPct,
          attempts: primary.attempts,
          deficitPct: primary.deficitPct,
          severity: primary.severity,
          confidence: primary.confidence,
        }
        : null,
      strugglingSubtopics: (subtopicSignal?.strugglingSubtopics || []).slice(0, 3).map((row) => ({
        subtopic: row.subtopic,
        accuracyPct: row.accuracyPct,
        attempts: row.attempts,
        deficitPct: row.deficitPct,
        severity: row.severity,
        confidence: row.confidence,
      })),
      consideredEntries: Math.max(0, asNonNegativeNumber(subtopicSignal?.consideredEntries, 0)),
      thresholdPct: Math.max(0, asNonNegativeNumber(subtopicSignal?.thresholdPct, 50)),
    },
    remediationPack,
  };
  injectRemediationIntoPlan(plan, remediationPack);
  return plan;
}

function finalizeExerciseMix(plan, ratioConfig = {}) {
  const base = buildExerciseMix(plan.prefs.minutes, plan.snapshot.accuracy, plan.snapshot.streak);
  const available = new Set(plan.unlockedModes || ['flashcards']);
  let mix = base.filter((item) => available.has(item.mode));
  if (!mix.some((item) => item.mode === 'flashcards')) {
    mix.unshift({ mode: 'flashcards', minutes: Math.max(3, Math.round(plan.prefs.minutes * 0.35)) });
  }
  if (plan.remediation?.active && Array.isArray(plan.remediation.focusModes) && plan.remediation.focusModes.length) {
    mix = mix.sort((a, b) => {
      const aIdx = plan.remediation.focusModes.indexOf(a.mode);
      const bIdx = plan.remediation.focusModes.indexOf(b.mode);
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });
  }
  const boostMode = ratioConfig.lowHeartsBoostMode || 'flashcards';
  if (plan.heartState?.lowHearts) {
    mix = mix.map((item) => item.mode === boostMode
      ? { ...item, minutes: item.minutes + 3 }
      : { ...item, minutes: Math.max(1, item.minutes - 1) });
  }
  plan.exerciseMix = mix;
  return plan;
}

function ensureStudyPlanPersonalizationContract(plan) {
  const safePlan = plan && typeof plan === 'object' ? plan : {};
  const safeSnapshot = safePlan.snapshot && typeof safePlan.snapshot === 'object'
    ? safePlan.snapshot
    : createEmptyProgress('');
  const safeAdaptive = safeSnapshot.adaptiveProfile && typeof safeSnapshot.adaptiveProfile === 'object'
    ? safeSnapshot.adaptiveProfile
    : createEmptyProgress('').adaptiveProfile;

  const dueReviews = asNonNegativeNumber(safePlan.dueReviews, 0);
  const remediationStatus = String(safePlan?.remediation?.status || (safePlan?.remediation?.active ? 'active' : 'clear'));

  safePlan.diagnosticLevel = String(safePlan.diagnosticLevel || safeAdaptive.targetLevel || 'A1').toUpperCase();
  safePlan.abilityScore = asBoundedNumber(safePlan.abilityScore, 0, 100, safeAdaptive.abilityScore || 0);
  safePlan.masteryGates = safePlan.masteryGates && typeof safePlan.masteryGates === 'object'
    ? safePlan.masteryGates
    : (safeAdaptive.masteryGates || {});
  safePlan.dueReviews = dueReviews;
  safePlan.remediation = {
    active: !!safePlan?.remediation?.active,
    status: remediationStatus,
    reason: String(safePlan?.remediation?.reason || ''),
    focusModes: Array.isArray(safePlan?.remediation?.focusModes)
      ? safePlan.remediation.focusModes.map((item) => String(item))
      : [],
    subtopicStruggle: !!safePlan?.remediation?.subtopicStruggle,
    subtopicSignals: safePlan?.remediation?.subtopicSignals || {
      primary: null,
      strugglingSubtopics: [],
      consideredEntries: 0,
      thresholdPct: 50,
    },
    remediationPack: safePlan?.remediation?.remediationPack || {
      active: false,
      words: [],
      totalSelected: 0,
      reason: '',
    },
  };

  safePlan.personalization = {
    diagnosticLevel: safePlan.diagnosticLevel,
    abilityScore: safePlan.abilityScore,
    masteryGates: safePlan.masteryGates,
    dueReviews,
    remediationStatus: safePlan.remediation.status,
  };

  return safePlan;
}

function isMasteredPlanWord(word) {
  if (!word || typeof word !== 'object') return false;
  if (String(word.learningStatus || '').toLowerCase() === 'mastered') return true;
  if (String(word.masteryStatus || '').toLowerCase() === 'mastered') return true;
  return !!word?.adaptiveMetrics?.masteredAt;
}

function buildProgressionUnlockState(snapshot, words, planProfile) {
  const completedLessons = Array.isArray(snapshot?.completedLessons) ? snapshot.completedLessons : [];
  const completedLessonCount = completedLessons.length;
  const currentModuleIndex = Math.max(1, Math.floor(completedLessonCount / 3) + 1);
  const moduleId = `module-${currentModuleIndex}`;
  const prerequisiteModuleIds = currentModuleIndex > 1 ? [`module-${currentModuleIndex - 1}`] : [];
  const completedModules = currentModuleIndex > 1
    ? Array.from({ length: currentModuleIndex - 1 }, (_, index) => `module-${index + 1}`)
    : [];
  const sessionHistory = completedLessons
    .filter((lesson) => isValidIsoDate(lesson?.date))
    .slice(-12)
    .map((lesson, index) => ({
      sessionId: `${moduleId}:lesson:${index}`,
      sessionAt: lesson.date,
      accuracy: asBoundedNumber(lesson?.accuracy, 0, 100, 0),
      totalCount: 1,
      correctCount: asBoundedNumber(lesson?.accuracy, 0, 100, 0) >= 80 ? 1 : 0,
      mode: String(lesson?.type || 'lesson'),
      responseTimeMs: Math.max(0, asNonNegativeNumber(lesson?.duration, 0)),
    }));
  const moduleWords = Array.isArray(words) ? words : [];
  const masteredWords = moduleWords.filter((word) => isMasteredPlanWord(word));
  const requiredMasteredItems = Math.max(3, Math.min(moduleWords.length || 3, Math.ceil((moduleWords.length || 3) * 0.4)));
  const moduleStats = {
    moduleId,
    title: `Module ${currentModuleIndex}`,
    prerequisiteModuleIds,
    completedModules,
    items: moduleWords,
    sessionHistory,
    requiredMasteredItems,
    requiredConsecutiveSessions: 3,
    rollingWindow: 3,
    accuracyThreshold: 80,
  };

  const unlock = canUnlockNextModule({
    completedModules,
    masteredModules: completedModules,
    moduleIds: completedModules,
    lessonsCompleted: completedLessonCount,
  }, moduleStats);

  return {
    ...unlock,
    moduleId,
    title: moduleStats.title,
    completedLessonCount,
    masteredWordCount: masteredWords.length,
    totalWordCount: moduleWords.length,
    nextModuleId: `module-${currentModuleIndex + 1}`,
    currentModuleIndex,
    prerequisiteModuleIds,
    completedModules,
    planWordCount: Number(planProfile?.targetWordCount || 0),
  };
}

function updateAdaptiveProfileFromSession(progress, sessionPayload = {}) {
  if (!progress || typeof progress !== 'object') return null;

  if (!progress.adaptiveProfile || typeof progress.adaptiveProfile !== 'object') {
    progress.adaptiveProfile = createEmptyProgress('').adaptiveProfile;
  }

  const adaptive = progress.adaptiveProfile && typeof progress.adaptiveProfile === 'object' ? progress.adaptiveProfile : {};
  const existingDiagnostic = adaptive.diagnostic && typeof adaptive.diagnostic === 'object' ? adaptive.diagnostic : {};
  const accuracy = asBoundedNumber(sessionPayload.accuracy, 0, 100, 0);
  const sessionXP = asNonNegativeNumber(sessionPayload.xpEarned, 0);
  const attemptList = Array.isArray(sessionPayload.attempts) ? sessionPayload.attempts : [];
  const wordsCompleted = asNonNegativeNumber(sessionPayload.wordsCompleted, 0);
  const derivedAttemptCount = attemptList.length > 0
    ? attemptList.length
    : Math.max(0, Math.round(wordsCompleted));
  const derivedCorrectCount = attemptList.length > 0
    ? attemptList.filter((item) => normalizeCorrectness(item?.correctness)).length
    : Math.round(derivedAttemptCount * (accuracy / 100));
  const latencyValues = attemptList
    .map((item) => asNonNegativeNumber(item?.latencyMs, NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const sessionLatencyMs = Number.isFinite(Number(sessionPayload.averageLatencyMs))
    ? asNonNegativeNumber(sessionPayload.averageLatencyMs, 0)
    : (latencyValues.length
      ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
      : 0);
  const previousSessionCount = Math.max(0, asNonNegativeNumber(progress.lessonsCompleted, 0) - 1);
  const previousAbilityScore = asBoundedNumber(adaptive.abilityScore, 0, 100, 0);
  const sessionAbilityScore = Math.round(Math.min(100, Math.max(0, accuracy + Math.min(12, sessionXP / 100))));
  const blendedAbilityScore = previousSessionCount === 0
    ? sessionAbilityScore
    : Math.round(((previousAbilityScore * previousSessionCount) + sessionAbilityScore) / (previousSessionCount + 1));
  const previousDiagnosticAttempts = asNonNegativeNumber(existingDiagnostic.attempts, 0);
  const previousDiagnosticCorrect = asNonNegativeNumber(existingDiagnostic.correct, 0);
  const previousDiagnosticLatency = asNonNegativeNumber(existingDiagnostic.averageLatencyMs, 0);
  const nextDiagnosticAttempts = previousDiagnosticAttempts + derivedAttemptCount;
  const nextDiagnosticCorrect = Math.min(nextDiagnosticAttempts, previousDiagnosticCorrect + derivedCorrectCount);
  const nextDiagnosticAccuracy = nextDiagnosticAttempts > 0
    ? Number(((nextDiagnosticCorrect / nextDiagnosticAttempts) * 100).toFixed(2))
    : asBoundedNumber(existingDiagnostic.accuracy, 0, 100, 0);
  const nextDiagnosticLatency = sessionLatencyMs > 0
    ? (previousDiagnosticLatency > 0 && nextDiagnosticAttempts > 0
      ? Math.round(((previousDiagnosticLatency * previousDiagnosticAttempts) + (sessionLatencyMs * derivedAttemptCount)) / Math.max(1, nextDiagnosticAttempts))
      : sessionLatencyMs)
    : previousDiagnosticLatency;

  const nextDifficultyBand = difficultyBandFromAbilityScore(blendedAbilityScore);

  progress.adaptiveProfile.targetLevel = inferTargetLevelFromAbilityScore(blendedAbilityScore);
  progress.adaptiveProfile.abilityScore = blendedAbilityScore;
  progress.adaptiveProfile.difficultyBand = nextDifficultyBand;
  progress.adaptiveProfile.diagnostic = {
    ...existingDiagnostic,
    completedAt: new Date().toISOString(),
    attempts: nextDiagnosticAttempts,
    correct: nextDiagnosticCorrect,
    accuracy: nextDiagnosticAccuracy,
    averageLatencyMs: nextDiagnosticLatency,
  };

  return progress.adaptiveProfile;
}

function toUtcDateKey(input = new Date()) {
  const d = new Date(input);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function applyDailyHistoryUpdate(progress, session) {
  if (!Array.isArray(progress.dailyHistory)) {
    progress.dailyHistory = [];
  }

  const now = new Date();
  const dateKey = toUtcDateKey(now);
  const xp = Math.max(Number(session.xpEarned || 0), 0);
  const words = Math.max(Number(session.wordsCompleted || 0), 0);
  const accuracy = Math.max(Math.min(Number(session.accuracy || 0), 100), 0);
  const studyMinutes = Math.max(Number((session.durationValue / 60).toFixed(2)), 0);
  const sessionType = String(session.sessionType || '').toLowerCase();

  let row = progress.dailyHistory.find((item) => item && item.dateKey === dateKey);
  if (!row) {
    row = {
      dateKey,
      xpEarned: 0,
      wordsLearned: 0,
      quizzesCompleted: 0,
      avgAccuracy: 0,
      studyMinutes: 0,
      sessionsCompleted: 0,
    };
    progress.dailyHistory.push(row);
  }

  row.xpEarned = asNonNegativeNumber(row.xpEarned, 0);
  row.wordsLearned = asNonNegativeNumber(row.wordsLearned, 0);
  row.quizzesCompleted = asNonNegativeNumber(row.quizzesCompleted, 0);
  row.studyMinutes = asNonNegativeNumber(row.studyMinutes, 0);
  row.sessionsCompleted = asNonNegativeNumber(row.sessionsCompleted, 0);
  row.avgAccuracy = asBoundedNumber(row.avgAccuracy, 0, 100, 0);

  const prevSessions = row.sessionsCompleted;
  const prevAvg = row.avgAccuracy;
  const nextSessions = prevSessions + 1;

  row.xpEarned = Math.max(Number(row.xpEarned || 0), 0) + xp;
  row.wordsLearned = Math.max(Number(row.wordsLearned || 0), 0) + words;
  row.quizzesCompleted = Math.max(Number(row.quizzesCompleted || 0), 0) + (sessionType.includes('quiz') ? 1 : 0);
  row.studyMinutes = Number((Math.max(Number(row.studyMinutes || 0), 0) + studyMinutes).toFixed(2));
  row.sessionsCompleted = nextSessions;
  row.avgAccuracy = Number((((prevAvg * prevSessions) + accuracy) / nextSessions).toFixed(2));

  progress.dailyHistory.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  if (progress.dailyHistory.length > 400) {
    progress.dailyHistory = progress.dailyHistory.slice(progress.dailyHistory.length - 400);
  }
}

function normalizeDailyHistoryRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.dateKey === 'string' && dateFromDateKey(row.dateKey))
    .map((row) => ({
      dateKey: String(row.dateKey),
      xpEarned: asNonNegativeNumber(row.xpEarned, 0),
      wordsLearned: asNonNegativeNumber(row.wordsLearned, 0),
      quizzesCompleted: asNonNegativeNumber(row.quizzesCompleted, 0),
      avgAccuracy: asBoundedNumber(row.avgAccuracy, 0, 100, 0),
      studyMinutes: asNonNegativeNumber(row.studyMinutes, 0),
      sessionsCompleted: asNonNegativeNumber(row.sessionsCompleted, 0),
    }))
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
}

function asNonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.max(n, 0);
}

function asBoundedNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseRangeDays(rawRange) {
  const n = Number(rawRange || 30);
  if (![7, 30, 90].includes(n)) return 30;
  return n;
}

function dateFromDateKey(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateKeyFromOffset(daysAgo) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return toUtcDateKey(d);
}

function dayNumberFromDateKey(dateKey) {
  const d = dateFromDateKey(dateKey);
  if (!d) return null;
  return Math.floor(d.getTime() / 86400000);
}

function dayNumberFromTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 86400000);
}

function deriveStreakFromDayNumbers(dayNumbersInput) {
  const uniqueDayNumbers = new Set();
  const dayNumbers = [];

  (Array.isArray(dayNumbersInput) ? dayNumbersInput : []).forEach((n) => {
    if (!Number.isFinite(n)) return;
    if (!uniqueDayNumbers.has(n)) {
      uniqueDayNumbers.add(n);
      dayNumbers.push(n);
    }
  });

  if (!dayNumbers.length) {
    return {
      currentStreak: 0,
      longestStreak: 0,
      lastActivityDate: null,
    };
  }

  dayNumbers.sort((a, b) => a - b);

  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < dayNumbers.length; i += 1) {
    if (dayNumbers[i] === dayNumbers[i - 1] + 1) run += 1;
    else run = 1;
    if (run > longestStreak) longestStreak = run;
  }

  const todayNumber = dayNumberFromDateKey(toUtcDateKey(new Date()));
  const anchor = uniqueDayNumbers.has(todayNumber) ? todayNumber : todayNumber - 1;
  let currentStreak = 0;
  let probe = anchor;
  while (uniqueDayNumbers.has(probe)) {
    currentStreak += 1;
    probe -= 1;
  }

  const lastDayNumber = dayNumbers[dayNumbers.length - 1];
  const lastActivityDate = new Date(lastDayNumber * 86400000).toISOString();

  return {
    currentStreak,
    longestStreak,
    lastActivityDate,
  };
}

function deriveLegacyStreakMetricsFromLessons(lessons) {
  const dayNumbers = (Array.isArray(lessons) ? lessons : [])
    .map((lesson) => dayNumberFromTimestamp(lesson?.date))
    .filter((n) => Number.isFinite(n));

  return deriveStreakFromDayNumbers(dayNumbers);
}

function isValidIsoDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function mostRecentLessonTimestamp(lessons) {
  let latest = null;
  (Array.isArray(lessons) ? lessons : []).forEach((lesson) => {
    if (!isValidIsoDate(lesson?.date)) return;
    const at = new Date(lesson.date).toISOString();
    if (!latest || new Date(at) > new Date(latest)) {
      latest = at;
    }
  });
  return latest;
}

function deriveStreakMetrics(rows) {
  const safeRows = normalizeDailyHistoryRows(rows)
    .filter((r) => Number(r.sessionsCompleted || 0) > 0);

  const dayNumbers = [];
  safeRows.forEach((row) => {
    const dayNumber = dayNumberFromDateKey(row.dateKey);
    if (dayNumber === null) return;
    dayNumbers.push(dayNumber);
  });

  return deriveStreakFromDayNumbers(dayNumbers);
}

function applyDerivedProgressMetrics(progress) {
  const rows = Array.isArray(progress?.dailyHistory) ? progress.dailyHistory : [];
  const streak = deriveStreakMetrics(rows);
  const existingLongest = asNonNegativeNumber(progress?.longestStreak, 0);
  const existingLastActivity = isValidIsoDate(progress?.lastActivityDate)
    ? new Date(progress.lastActivityDate).toISOString()
    : null;

  progress.streak = streak.currentStreak;
  progress.longestStreak = Math.max(existingLongest, streak.longestStreak);
  if (!existingLastActivity && streak.lastActivityDate) {
    progress.lastActivityDate = streak.lastActivityDate;
  }
}

function isLikelyTestEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.endsWith('@test.local') ||
    normalized.endsWith('@test.com') ||
    normalized.endsWith('@example.com')
  );
}

function isLikelyDemoUser(user) {
  if (!user) return true;
  return user.isSeedAccount === true || isLikelyTestEmail(user.email);
}

function normalizeStoredGate(gate, fallbackReason) {
  const entry = gate && typeof gate === 'object' ? gate : {};
  const rawSubSkills = entry.subSkills && typeof entry.subSkills === 'object' ? entry.subSkills : {};
  const transitionHistory = Array.isArray(entry.transitionHistory)
    ? entry.transitionHistory.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
    : [];
  const normalizedSubSkills = Object.fromEntries(
    Object.entries(rawSubSkills)
      .filter(([, subSkill]) => subSkill && typeof subSkill === 'object')
      .map(([key, subSkill]) => [key, {
        label: String(subSkill.label || key),
        passed: !!subSkill.passed,
        score: Number(subSkill.score || 0),
        threshold: Number(subSkill.threshold || 0),
        reason: String(subSkill.reason || ''),
      }])
  );
  return {
    unlocked: entry.unlocked !== false,
    reason: String(entry.reason || fallbackReason),
    requiredSubSkills: Array.isArray(entry.requiredSubSkills)
      ? entry.requiredSubSkills.filter((value) => typeof value === 'string').map((value) => String(value))
      : [],
    subSkills: normalizedSubSkills,
    lastUnlockedAt: entry.lastUnlockedAt ? String(entry.lastUnlockedAt) : null,
    lastLockedAt: entry.lastLockedAt ? String(entry.lastLockedAt) : null,
    transitionCount: Math.max(0, Number(entry.transitionCount || 0)),
    transitionHistory,
  };
}

function buildTransitionedGate(previousGate, unlocked, reason, subSkills) {
  const previousEntry = normalizeStoredGate(previousGate, reason);
  const previousUnlocked = previousEntry.unlocked;
  const transitionHistory = Array.isArray(previousEntry.transitionHistory) ? previousEntry.transitionHistory.slice(-12) : [];
  const now = new Date().toISOString();
  const changed = previousUnlocked !== unlocked;
  if (changed) {
    transitionHistory.push({
      at: now,
      from: previousUnlocked ? 'unlocked' : 'locked',
      to: unlocked ? 'unlocked' : 'locked',
      reason: String(reason || ''),
    });
  }
  const transitionCount = Math.max(0, Number(previousEntry.transitionCount || 0) + (changed ? 1 : 0));
  return {
    unlocked,
    reason: String(reason || ''),
    requiredSubSkills: Object.keys(subSkills || {}),
    subSkills,
    lastUnlockedAt: unlocked
      ? (changed && !previousUnlocked ? now : previousEntry.lastUnlockedAt || null)
      : previousEntry.lastUnlockedAt || null,
    lastLockedAt: unlocked
      ? previousEntry.lastLockedAt || null
      : (changed && previousUnlocked ? now : previousEntry.lastLockedAt || null),
    transitionCount,
    transitionHistory: transitionHistory.slice(-12),
  };
}

function enforceModeAccess(plan, requestedMode) {
  return buildModeAccess(plan, requestedMode, 'flashcards');
}

function normalizeProgressSnapshot(progress, userId) {
  const fallback = createEmptyProgress(userId);
  const base = progress || fallback;
  const dailyHistory = normalizeDailyHistoryRows(base.dailyHistory || []);
  const hasDailyHistory = dailyHistory.some((row) => Number(row.sessionsCompleted || 0) > 0);
  const streak = hasDailyHistory
    ? deriveStreakMetrics(dailyHistory)
    : deriveLegacyStreakMetricsFromLessons(base.completedLessons || []);
  const lessonTimestamp = mostRecentLessonTimestamp(base.completedLessons || []);
  const storedTimestamp = isValidIsoDate(base.lastActivityDate)
    ? new Date(base.lastActivityDate).toISOString()
    : null;
  const preciseLastActivity = lessonTimestamp || storedTimestamp || streak.lastActivityDate || new Date().toISOString();
  const adaptive = base && typeof base.adaptiveProfile === 'object' ? base.adaptiveProfile : {};
  const adaptiveBand = adaptive && typeof adaptive.difficultyBand === 'object' ? adaptive.difficultyBand : {};
  const adaptiveDiagnostic = adaptive && typeof adaptive.diagnostic === 'object' ? adaptive.diagnostic : {};
  const adaptiveBehavior = adaptive && typeof adaptive.behaviorSignals === 'object' ? adaptive.behaviorSignals : {};
  const adaptiveGates = adaptive && typeof adaptive.masteryGates === 'object' ? adaptive.masteryGates : {};
  const adaptiveRemediation = adaptive && typeof adaptive.remediation === 'object' ? adaptive.remediation : {};
  const adaptiveQueue = base && typeof base.adaptiveQueue === 'object' ? base.adaptiveQueue : {};
  const adaptiveQueueMix = adaptiveQueue && typeof adaptiveQueue.mix === 'object' ? adaptiveQueue.mix : {};
  const activeQueue = adaptiveQueue && typeof adaptiveQueue.activeQueue === 'object' ? adaptiveQueue.activeQueue : {};
  const activeQueueSettings = activeQueue && typeof activeQueue.settings === 'object' ? activeQueue.settings : {};
  const activeQueueBand = activeQueueSettings && typeof activeQueueSettings.difficultyBand === 'object' ? activeQueueSettings.difficultyBand : {};
  const activeQueueCursor = activeQueue && typeof activeQueue.cursor === 'object' ? activeQueue.cursor : {};
  const activeQueueMode = activeQueue && typeof activeQueue.modeProgress === 'object' ? activeQueue.modeProgress : {};
  return {
    ...fallback,
    ...base,
    userId: base.userId || userId,
    totalXP: asNonNegativeNumber(base.totalXP, 0),
    streak: streak.currentStreak,
    longestStreak: Math.max(asNonNegativeNumber(base.longestStreak, 0), streak.longestStreak),
    lessonsCompleted: asNonNegativeNumber(base.lessonsCompleted, 0),
    wordsLearned: asNonNegativeNumber(base.wordsLearned, 0),
    accuracy: asBoundedNumber(base.accuracy, 0, 100, 0),
    totalStudyTime: asNonNegativeNumber(base.totalStudyTime, 0),
    adaptiveProfile: {
      targetLevel: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(String(adaptive.targetLevel || '').toUpperCase())
        ? String(adaptive.targetLevel).toUpperCase()
        : 'A1',
      abilityScore: asBoundedNumber(adaptive.abilityScore, 0, 100, 0),
      difficultyBand: {
        min: asBoundedNumber(adaptiveBand.min, 1, 5, 1),
        max: asBoundedNumber(adaptiveBand.max, 1, 5, 2),
      },
      diagnostic: {
        completedAt: isValidIsoDate(adaptiveDiagnostic.completedAt)
          ? new Date(adaptiveDiagnostic.completedAt).toISOString()
          : null,
        attempts: asNonNegativeNumber(adaptiveDiagnostic.attempts, 0),
        correct: asNonNegativeNumber(adaptiveDiagnostic.correct, 0),
        accuracy: asBoundedNumber(adaptiveDiagnostic.accuracy, 0, 100, 0),
        averageLatencyMs: asNonNegativeNumber(adaptiveDiagnostic.averageLatencyMs, 0),
        sessionToken: adaptiveDiagnostic.sessionToken ? String(adaptiveDiagnostic.sessionToken) : null,
      },
      behaviorSignals: {
        baselineLatencyMs: asNonNegativeNumber(adaptiveBehavior.baselineLatencyMs, 2200),
        confidenceScore: clampNumber(adaptiveBehavior.confidenceScore, 0, 1, 0.6),
        fastGuessRate: clampNumber(adaptiveBehavior.fastGuessRate, 0, 1, 0),
        slowStruggleRate: clampNumber(adaptiveBehavior.slowStruggleRate, 0, 1, 0),
        recentBehaviors: Array.isArray(adaptiveBehavior.recentBehaviors) ? adaptiveBehavior.recentBehaviors.slice(-12).map((item) => String(item)) : [],
        updatedAt: isValidIsoDate(adaptiveBehavior.updatedAt) ? new Date(adaptiveBehavior.updatedAt).toISOString() : null,
      },
      masteryGates: {
        flashcards: normalizeStoredGate(adaptiveGates.flashcards, 'Available by default.'),
        matching: normalizeStoredGate(adaptiveGates.matching, 'Improve confidence or accuracy to unlock.'),
        quiz: normalizeStoredGate(adaptiveGates.quiz, 'Improve confidence or accuracy to unlock.'),
        spelling: normalizeStoredGate(adaptiveGates.spelling, 'Improve confidence or accuracy to unlock.'),
      },
      remediation: {
        active: !!adaptiveRemediation.active,
        reason: String(adaptiveRemediation.reason || ''),
        focusModes: Array.isArray(adaptiveRemediation.focusModes) ? adaptiveRemediation.focusModes.map((item) => String(item)) : [],
        recommendedWordIds: Array.isArray(adaptiveRemediation.recommendedWordIds) ? adaptiveRemediation.recommendedWordIds.map((item) => String(item)) : [],
        updatedAt: isValidIsoDate(adaptiveRemediation.updatedAt) ? new Date(adaptiveRemediation.updatedAt).toISOString() : null,
      },
    },
    completedLessons: Array.isArray(base.completedLessons) ? base.completedLessons : [],
    dailyHistory,
    adaptiveQueue: {
      generatedAt: isValidIsoDate(adaptiveQueue.generatedAt) ? new Date(adaptiveQueue.generatedAt).toISOString() : null,
      targetWords: asNonNegativeNumber(adaptiveQueue.targetWords, 0),
      dueReviewCount: asNonNegativeNumber(adaptiveQueue.dueReviewCount, 0),
      remediationCount: asNonNegativeNumber(adaptiveQueue.remediationCount, 0),
      mix: {
        totalRequested: asNonNegativeNumber(adaptiveQueueMix.totalRequested, 0),
        targetCounts: {
          current: asNonNegativeNumber(adaptiveQueueMix?.targetCounts?.current, 0),
          stretch: asNonNegativeNumber(adaptiveQueueMix?.targetCounts?.stretch, 0),
          review: asNonNegativeNumber(adaptiveQueueMix?.targetCounts?.review, 0),
        },
        counts: {
          current: asNonNegativeNumber(adaptiveQueueMix?.counts?.current, 0),
          stretch: asNonNegativeNumber(adaptiveQueueMix?.counts?.stretch, 0),
          review: asNonNegativeNumber(adaptiveQueueMix?.counts?.review, 0),
        },
        ratios: {
          current: asBoundedNumber(adaptiveQueueMix?.ratios?.current, 0, 1, 0.7),
          stretch: asBoundedNumber(adaptiveQueueMix?.ratios?.stretch, 0, 1, 0.2),
          review: asBoundedNumber(adaptiveQueueMix?.ratios?.review, 0, 1, 0.1),
        },
      },
      queuePreview: Array.isArray(adaptiveQueue.queuePreview) ? adaptiveQueue.queuePreview.map((item) => ({
        wordId: String(item?.wordId || ''),
        word: String(item?.word || ''),
        hint: String(item?.hint || ''),
        imageUrl: String(item?.imageUrl || ''),
        difficulty: asBoundedNumber(item?.difficulty, 1, 5, 3),
        source: String(item?.source || 'general'),
        position: Math.max(0, asNonNegativeNumber(item?.position, 0)),
      })) : [],
      activeQueue: {
        planId: activeQueue.planId ? String(activeQueue.planId) : null,
        queueId: activeQueue.queueId ? String(activeQueue.queueId) : null,
        status: activeQueue.status ? String(activeQueue.status) : null,
        version: Math.max(1, asNonNegativeNumber(activeQueue.version, 1)),
        createdAt: isValidIsoDate(activeQueue.createdAt) ? new Date(activeQueue.createdAt).toISOString() : null,
        expiresAt: isValidIsoDate(activeQueue.expiresAt) ? new Date(activeQueue.expiresAt).toISOString() : null,
        completedAt: isValidIsoDate(activeQueue.completedAt) ? new Date(activeQueue.completedAt).toISOString() : null,
        abandonedAt: isValidIsoDate(activeQueue.abandonedAt) ? new Date(activeQueue.abandonedAt).toISOString() : null,
        settings: {
          minutes: clampNumber(activeQueueSettings.minutes, 10, 120, 20),
          wordCount: clampNumber(activeQueueSettings.wordCount, 5, 60, 16),
          targetLevel: String(activeQueueSettings.targetLevel || 'AUTO').toUpperCase(),
          hearts: clampNumber(activeQueueSettings.hearts, 0, 5, 5),
          difficultyBand: {
            min: clampNumber(activeQueueBand.min, 1, 5, 1),
            max: clampNumber(activeQueueBand.max, 1, 5, 5),
            label: String(activeQueueBand.label || 'Auto'),
          },
        },
        cursor: {
          nextIndex: Math.max(0, asNonNegativeNumber(activeQueueCursor.nextIndex, 0)),
          completedCount: Math.max(0, asNonNegativeNumber(activeQueueCursor.completedCount, 0)),
        },
        modeProgress: {
          flashcards: Math.max(0, asNonNegativeNumber(activeQueueMode.flashcards, 0)),
          quiz: Math.max(0, asNonNegativeNumber(activeQueueMode.quiz, 0)),
          matching: Math.max(0, asNonNegativeNumber(activeQueueMode.matching, 0)),
          spelling: Math.max(0, asNonNegativeNumber(activeQueueMode.spelling, 0)),
        },
        items: Array.isArray(activeQueue.items) ? activeQueue.items.map((item, index) => ({
          queueItemId: String(item?.queueItemId || `${index}`),
          position: Math.max(0, asNonNegativeNumber(item?.position, index)),
          wordId: String(item?.wordId || ''),
          word: String(item?.word || ''),
          definition: String(item?.definition || ''),
          hint: String(item?.hint || ''),
          imageUrl: String(item?.imageUrl || ''),
          difficulty: clampNumber(item?.difficulty, 1, 5, 3),
          source: String(item?.source || 'general'),
          status: String(item?.status || 'pending'),
          attempts: Math.max(0, asNonNegativeNumber(item?.attempts, 0)),
          correctAttempts: Math.max(0, asNonNegativeNumber(item?.correctAttempts, 0)),
          latencyMsAvg: Math.max(0, asNonNegativeNumber(item?.latencyMsAvg, 0)),
          lastLatencyMs: Math.max(0, asNonNegativeNumber(item?.lastLatencyMs, 0)),
          behavior: item?.behavior ? String(item.behavior) : null,
          requeueCount: Math.max(0, asNonNegativeNumber(item?.requeueCount, 0)),
          lastMode: item?.lastMode ? String(item.lastMode) : null,
          lastAttemptAt: isValidIsoDate(item?.lastAttemptAt) ? new Date(item.lastAttemptAt).toISOString() : null,
        })) : [],
        attemptLedger: Array.isArray(activeQueue.attemptLedger) ? activeQueue.attemptLedger.slice(-150).map((entry) => ({
          idempotencyKey: String(entry?.idempotencyKey || ''),
          queueItemId: String(entry?.queueItemId || ''),
          mode: String(entry?.mode || ''),
          accepted: !!entry?.accepted,
          advancedToIndex: Math.max(0, asNonNegativeNumber(entry?.advancedToIndex, 0)),
          version: Math.max(1, asNonNegativeNumber(entry?.version, 1)),
          createdAt: isValidIsoDate(entry?.createdAt) ? new Date(entry.createdAt).toISOString() : null,
          response: entry?.response || null,
        })) : [],
      },
    },
    lastActivityDate: preciseLastActivity,
  };
}

function buildAccuracyMetric(progressSnapshot) {
  const rows = normalizeDailyHistoryRows(progressSnapshot?.dailyHistory || []);

  let weightedAccTotal = 0;
  let weightedSessionCount = 0;
  rows.forEach((row) => {
    const sessions = asNonNegativeNumber(row.sessionsCompleted, 0);
    const acc = asBoundedNumber(row.avgAccuracy, 0, 100, 0);
    weightedAccTotal += acc * sessions;
    weightedSessionCount += sessions;
  });

  let weightedAverage = 0;
  if (weightedSessionCount > 0) {
    weightedAverage = Number((weightedAccTotal / weightedSessionCount).toFixed(2));
  } else {
    const lessons = Array.isArray(progressSnapshot?.completedLessons)
      ? progressSnapshot.completedLessons
      : [];
    const valid = lessons
      .map((lesson) => asBoundedNumber(lesson?.accuracy, 0, 100, NaN))
      .filter((n) => Number.isFinite(n));
    if (valid.length) {
      const sum = valid.reduce((acc, n) => acc + n, 0);
      weightedAverage = Number((sum / valid.length).toFixed(2));
      weightedSessionCount = valid.length;
    }
  }

  return {
    value: weightedAverage,
    sessions: weightedSessionCount,
  };
}

function buildAchievementRows(progress) {
  const p = normalizeProgressSnapshot(progress, progress?.userId || '');
  const accuracyMetric = buildAccuracyMetric(p);
  const metricByCategory = {
    xp: p.totalXP,
    streak: p.streak,
    words: p.wordsLearned,
    lessons: p.lessonsCompleted,
    sessions: p.completedLessons.length,
    accuracy_weighted: accuracyMetric.value,
  };

  return ACHIEVEMENT_RULES.map((rule) => {
    const value = asNonNegativeNumber(metricByCategory[rule.category], 0);
    const minSessions = asNonNegativeNumber(rule.minSessions, 0);
    const hasRequiredSessions = minSessions ? accuracyMetric.sessions >= minSessions : true;
    const unlocked = value >= rule.threshold && hasRequiredSessions;
    const progressPct = Math.min(100, Math.round((value / rule.threshold) * 100));
    return {
      id: rule.id,
      title: rule.title,
      description: rule.description,
      category: rule.category,
      threshold: rule.threshold,
      minSessions,
      sessionCount: accuracyMetric.sessions,
      value,
      unlocked,
      progressPct,
    };
  });
}

function calculateLevelFromXP(totalXP) {
  const xp = asNonNegativeNumber(totalXP, 0);
  if (xp === 0) return 1;
  const level = Math.floor(Math.log10(xp / 10 + 1) * 20) + 1;
  return Math.min(level, 100);
}

function xpForNextLevel(level) {
  const currentLevel = Math.max(1, Math.min(100, Number(level) || 1));
  if (currentLevel >= 100) return null;
  return Math.round(Math.pow(10, currentLevel / 20) * 10);
}

function buildLevelPayload(totalXP) {
  const xp = asNonNegativeNumber(totalXP, 0);
  const level = calculateLevelFromXP(xp);
  const previousLevelXP = level <= 1 ? 0 : Math.round(Math.pow(10, (level - 1) / 20) * 10);
  const nextLevelXP = xpForNextLevel(level);
  const span = nextLevelXP ? Math.max(nextLevelXP - previousLevelXP, 1) : 1;
  const gainedInLevel = Math.max(xp - previousLevelXP, 0);
  const progressPct = nextLevelXP ? Math.min(100, Math.round((gainedInLevel / span) * 100)) : 100;
  return {
    level,
    totalXP: xp,
    nextLevelXP,
    previousLevelXP,
    progressPct,
    xpToNextLevel: nextLevelXP ? Math.max(nextLevelXP - xp, 0) : 0,
  };
}

function buildStreakMilestone(previousStreak, currentStreak) {
  const prev = asNonNegativeNumber(previousStreak, 0);
  const now = asNonNegativeNumber(currentStreak, 0);
  const milestones = [3, 7, 14, 30, 60, 100];
  const hit = milestones.find((m) => prev < m && now >= m);
  if (!hit) return null;
  return { days: hit };
}

function buildGamificationDelta(beforeSnapshot, afterSnapshot, xpEarned) {
  const before = normalizeProgressSnapshot(beforeSnapshot || null, beforeSnapshot?.userId || afterSnapshot?.userId || '');
  const after = normalizeProgressSnapshot(afterSnapshot || null, afterSnapshot?.userId || before.userId || '');

  const beforeLevel = calculateLevelFromXP(before.totalXP);
  const afterLevelPayload = buildLevelPayload(after.totalXP);

  const beforeAchievements = buildAchievementRows(before).filter((a) => a.unlocked);
  const afterAchievements = buildAchievementRows(after).filter((a) => a.unlocked);
  const beforeAchievementIds = new Set(beforeAchievements.map((a) => String(a.id)));
  const newlyUnlocked = afterAchievements.filter((a) => !beforeAchievementIds.has(String(a.id)));

  return {
    xpEarned: asNonNegativeNumber(xpEarned, 0),
    totalXP: after.totalXP,
    streak: {
      current: after.streak,
      previous: before.streak,
      longest: after.longestStreak,
      milestone: buildStreakMilestone(before.streak, after.streak),
    },
    level: {
      previous: beforeLevel,
      current: afterLevelPayload.level,
      leveledUp: afterLevelPayload.level > beforeLevel,
      totalXP: afterLevelPayload.totalXP,
      nextLevelXP: afterLevelPayload.nextLevelXP,
      previousLevelXP: afterLevelPayload.previousLevelXP,
      progressPct: afterLevelPayload.progressPct,
      xpToNextLevel: afterLevelPayload.xpToNextLevel,
    },
    achievements: {
      unlockedTotal: afterAchievements.length,
      newlyUnlocked,
    },
  };
}

function toPublicLeaderboardUser(user) {
  return {
    id: String(user?._id || user?.id || ''),
    name: String(user?.name || 'Unknown Learner'),
    email: String(user?.email || '').toLowerCase(),
    role: String(user?.role || 'student').toLowerCase(),
    isActive: user?.isActive !== false,
    isSeedAccount: !!user?.isSeedAccount,
    creatorCode: String(user?.creatorCode || '').toUpperCase(),
    linkedCreatorCode: String(user?.linkedCreatorCode || '').toUpperCase(),
    classes: Array.isArray(user?.classes) ? user.classes : [],
  };
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function parseLeaderboardScope(rawScope) {
  const scope = String(rawScope || 'global').toLowerCase();
  if (scope === 'creator' || scope === 'class') return scope;
  return 'global';
}

function parseLeaderboardWindowDays(rawPeriod, rawWindowDays) {
  const explicitWindow = Number(rawWindowDays);
  if ([7, 30, 90].includes(explicitWindow)) return explicitWindow;

  const period = String(rawPeriod || 'all').toLowerCase();
  if (period === 'weekly') return 7;
  if (period === 'monthly') return 30;
  return 0;
}

function toPeriodLabel(windowDays) {
  if (windowDays === 7) return 'weekly';
  if (windowDays === 30) return 'monthly';
  if (windowDays === 90) return 'quarterly';
  return 'all_time';
}

function findTargetCreatorForClassScope(users, requester) {
  if (!requester) return null;
  if (requester.role === 'creator') return requester;
  if (!requester.linkedCreatorCode) return null;
  return users.find((u) => u.role === 'creator' && u.creatorCode === requester.linkedCreatorCode) || null;
}

function resolveClassForScope(creator, classCode, requesterId) {
  const classes = Array.isArray(creator?.classes) ? creator.classes : [];
  if (!classes.length) return null;

  if (classCode) {
    return classes.find((c) => normalizeCode(c?.code) === classCode) || null;
  }

  const byStudentMembership = classes.find((c) => (Array.isArray(c?.students) ? c.students : [])
    .some((studentId) => String(studentId) === String(requesterId)));
  if (byStudentMembership) return byStudentMembership;

  return classes.length === 1 ? classes[0] : null;
}

function filterUsersForLeaderboardScope(userRows, options = {}) {
  const scope = parseLeaderboardScope(options.scope);
  const classCode = normalizeCode(options.classCode);
  const requesterId = String(options.requesterId || '');
  const users = (Array.isArray(userRows) ? userRows : []).map((u) => toPublicLeaderboardUser(u));
  const requester = users.find((u) => u.id === requesterId) || null;

  if (scope === 'global') {
    return {
      users,
      scope,
      creatorCodeApplied: null,
      classCodeApplied: null,
    };
  }

  if (scope === 'creator') {
    const creatorCode = normalizeCode(
      options.creatorCode
        || requester?.creatorCode
        || requester?.linkedCreatorCode
    );
    if (!creatorCode) {
      return {
        users: [],
        scope,
        creatorCodeApplied: null,
        classCodeApplied: null,
      };
    }

    const scopedUsers = users.filter((u) => u.creatorCode === creatorCode || u.linkedCreatorCode === creatorCode);
    return {
      users: scopedUsers,
      scope,
      creatorCodeApplied: creatorCode,
      classCodeApplied: null,
    };
  }

  const creator = findTargetCreatorForClassScope(users, requester);
  const targetClass = resolveClassForScope(creator, classCode, requesterId);
  if (!targetClass) {
    return {
      users: [],
      scope,
      creatorCodeApplied: creator?.creatorCode || null,
      classCodeApplied: null,
    };
  }

  const classStudents = new Set(
    (Array.isArray(targetClass.students) ? targetClass.students : []).map((id) => String(id))
  );
  const scopedUsers = users.filter((u) => classStudents.has(String(u.id)));
  return {
    users: scopedUsers,
    scope,
    creatorCodeApplied: creator?.creatorCode || null,
    classCodeApplied: normalizeCode(targetClass.code),
  };
}

function buildLeaderboardWindowMetrics(progressSnapshot, windowDays) {
  if (!windowDays) {
    return {
      totalXP: asNonNegativeNumber(progressSnapshot.totalXP, 0),
      streak: asNonNegativeNumber(progressSnapshot.streak, 0),
      lessonsCompleted: asNonNegativeNumber(progressSnapshot.lessonsCompleted, 0),
      avgAccuracy: asBoundedNumber(progressSnapshot.accuracy, 0, 100, 0),
      lastActivityDate: progressSnapshot.lastActivityDate || null,
    };
  }

  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (windowDays - 1));

  const lessons = (Array.isArray(progressSnapshot.completedLessons) ? progressSnapshot.completedLessons : [])
    .filter((lesson) => {
      const at = lesson?.date ? new Date(lesson.date) : null;
      return at && !Number.isNaN(at.getTime()) && at >= cutoff;
    });

  const totalXP = lessons.reduce((sum, lesson) => sum + asNonNegativeNumber(lesson?.xp, 0), 0);
  const lessonsCompleted = lessons.length;
  const avgAccuracy = lessonsCompleted
    ? Number((lessons.reduce((sum, lesson) => sum + asBoundedNumber(lesson?.accuracy, 0, 100, 0), 0) / lessonsCompleted).toFixed(2))
    : 0;
  const streakMetrics = deriveLegacyStreakMetricsFromLessons(lessons);
  const lastActivityDate = mostRecentLessonTimestamp(lessons) || null;

  return {
    totalXP,
    streak: streakMetrics.currentStreak,
    lessonsCompleted,
    avgAccuracy,
    lastActivityDate,
  };
}

function buildLeaderboardRows(userRows, progressRows, options = {}) {
  const windowDays = Number(options.windowDays || 0);
  const progressMap = new Map();
  (Array.isArray(progressRows) ? progressRows : []).forEach((p) => {
    const snapshot = normalizeProgressSnapshot(p, p?.userId);
    progressMap.set(String(snapshot.userId), snapshot);
  });

  const rows = (Array.isArray(userRows) ? userRows : [])
    .map((u) => toPublicLeaderboardUser(u))
    .filter((u) => u.id && u.isActive && u.role !== 'admin' && !isLikelyDemoUser(u))
    .map((u) => {
      const stats = progressMap.get(String(u.id)) || normalizeProgressSnapshot(null, u.id);
      const metrics = buildLeaderboardWindowMetrics(stats, windowDays);
      return {
        userId: u.id,
        name: u.name,
        totalXP: asNonNegativeNumber(metrics.totalXP, 0),
        streak: asNonNegativeNumber(metrics.streak, 0),
        wordsLearned: asNonNegativeNumber(stats.wordsLearned, 0),
        lessonsCompleted: asNonNegativeNumber(metrics.lessonsCompleted, 0),
        avgAccuracy: asBoundedNumber(metrics.avgAccuracy, 0, 100, 0),
        lastActivityDate: metrics.lastActivityDate,
      };
    })
    .filter((row) => row.totalXP > 0 || row.lessonsCompleted > 0)
    .sort((a, b) => {
      if (b.totalXP !== a.totalXP) return b.totalXP - a.totalXP;
      if (b.streak !== a.streak) return b.streak - a.streak;
      if (b.lessonsCompleted !== a.lessonsCompleted) return b.lessonsCompleted - a.lessonsCompleted;
      return String(a.name).localeCompare(String(b.name));
    })
    .map((row, idx) => ({
      rank: idx + 1,
      ...row,
    }));

  return rows;
}

function mapHistoryRows(rows) {
  const mapped = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row || !row.dateKey) return;
    mapped.set(String(row.dateKey), {
      dateKey: String(row.dateKey),
      xpEarned: Number(row.xpEarned || 0),
      wordsLearned: Number(row.wordsLearned || 0),
      quizzesCompleted: Number(row.quizzesCompleted || 0),
      avgAccuracy: Number(row.avgAccuracy || 0),
      studyMinutes: Number(row.studyMinutes || 0),
      sessionsCompleted: Number(row.sessionsCompleted || 0),
    });
  });
  return mapped;
}

function buildSeries(rows, days) {
  const map = mapHistoryRows(rows);
  const output = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dateKey = toDateKeyFromOffset(offset);
    const row = map.get(dateKey);
    output.push(row || {
      dateKey,
      xpEarned: 0,
      wordsLearned: 0,
      quizzesCompleted: 0,
      avgAccuracy: 0,
      studyMinutes: 0,
      sessionsCompleted: 0,
    });
  }
  return output;
}

function summarizeSeries(series) {
  const base = {
    xpEarned: 0,
    wordsLearned: 0,
    quizzesCompleted: 0,
    studyMinutes: 0,
    sessionsCompleted: 0,
    avgAccuracy: 0,
  };
  if (!Array.isArray(series) || !series.length) return base;

  const totals = series.reduce((acc, row) => {
    const sessions = Number(row.sessionsCompleted || 0);
    acc.xpEarned += Number(row.xpEarned || 0);
    acc.wordsLearned += Number(row.wordsLearned || 0);
    acc.quizzesCompleted += Number(row.quizzesCompleted || 0);
    acc.studyMinutes += Number(row.studyMinutes || 0);
    acc.sessionsCompleted += sessions;
    acc.weightedAccuracy += Number(row.avgAccuracy || 0) * sessions;
    return acc;
  }, { ...base, weightedAccuracy: 0 });

  const avgAccuracy = totals.sessionsCompleted
    ? Number((totals.weightedAccuracy / totals.sessionsCompleted).toFixed(2))
    : 0;

  return {
    xpEarned: Number(totals.xpEarned.toFixed(2)),
    wordsLearned: Number(totals.wordsLearned.toFixed(2)),
    quizzesCompleted: Number(totals.quizzesCompleted.toFixed(2)),
    studyMinutes: Number(totals.studyMinutes.toFixed(2)),
    sessionsCompleted: totals.sessionsCompleted,
    avgAccuracy,
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return current > 0 ? 100 : 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function buildPeriodComparison(allRows, rangeDays) {
  const map = mapHistoryRows(allRows);
  const current = [];
  const previous = [];

  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const currentKey = toDateKeyFromOffset(offset);
    const prevKey = toDateKeyFromOffset(offset + rangeDays);
    current.push(map.get(currentKey) || { dateKey: currentKey, xpEarned: 0, wordsLearned: 0, quizzesCompleted: 0, avgAccuracy: 0, studyMinutes: 0, sessionsCompleted: 0 });
    previous.push(map.get(prevKey) || { dateKey: prevKey, xpEarned: 0, wordsLearned: 0, quizzesCompleted: 0, avgAccuracy: 0, studyMinutes: 0, sessionsCompleted: 0 });
  }

  const currentSummary = summarizeSeries(current);
  const previousSummary = summarizeSeries(previous);

  return {
    current: currentSummary,
    previous: previousSummary,
    delta: {
      xpEarnedPct: percentChange(currentSummary.xpEarned, previousSummary.xpEarned),
      wordsLearnedPct: percentChange(currentSummary.wordsLearned, previousSummary.wordsLearned),
      quizzesCompletedPct: percentChange(currentSummary.quizzesCompleted, previousSummary.quizzesCompleted),
      studyMinutesPct: percentChange(currentSummary.studyMinutes, previousSummary.studyMinutes),
      avgAccuracyPct: percentChange(currentSummary.avgAccuracy, previousSummary.avgAccuracy),
    },
  };
}

function parseWindowDays(rawDays) {
  const n = Number(rawDays || 30);
  if (![7, 14, 30, 90].includes(n)) return 30;
  return n;
}

function normalizeLessonType(type) {
  const t = String(type || 'other').toLowerCase().trim();
  if (!t) return 'other';
  if (t.includes('flash')) return 'flashcards';
  if (t.includes('quiz')) return 'quiz';
  if (t.includes('match')) return 'matching';
  if (t.includes('spell')) return 'spelling';
  return t;
}

function aggregateByLessonType(lessons, windowDays) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (windowDays - 1));
  cutoff.setUTCHours(0, 0, 0, 0);

  const map = new Map();
  (Array.isArray(lessons) ? lessons : []).forEach((lesson) => {
    const at = lesson?.date ? new Date(lesson.date) : null;
    if (!at || Number.isNaN(at.getTime()) || at < cutoff) return;

    const type = normalizeLessonType(lesson.type);
    const row = map.get(type) || {
      type,
      sessions: 0,
      totalXP: 0,
      totalDurationSec: 0,
      avgAccuracy: 0,
      lastPracticedAt: null,
    };

    row.sessions += 1;
    row.totalXP += asNonNegativeNumber(lesson.xp, 0);
    row.totalDurationSec += asNonNegativeNumber(lesson.duration, 0);
    const prevAvg = Number(row.avgAccuracy || 0);
    const nextAcc = asBoundedNumber(lesson.accuracy, 0, 100, 0);
    row.avgAccuracy = Number((((prevAvg * (row.sessions - 1)) + nextAcc) / row.sessions).toFixed(2));
    row.lastPracticedAt = !row.lastPracticedAt || new Date(row.lastPracticedAt) < at ? at.toISOString() : row.lastPracticedAt;

    map.set(type, row);
  });

  return Array.from(map.values())
    .sort((a, b) => b.sessions - a.sessions)
    .map((row) => ({
      ...row,
      totalXP: Number(row.totalXP.toFixed(2)),
      totalDurationSec: Number(row.totalDurationSec.toFixed(2)),
      totalDurationMin: Number((row.totalDurationSec / 60).toFixed(2)),
    }));
}

function deriveSkillGaps(typeRows) {
  const gaps = [];
  (Array.isArray(typeRows) ? typeRows : []).forEach((row) => {
    const hasAccuracyGap = row.avgAccuracy < 75;
    if (hasAccuracyGap) {
      gaps.push({
        type: row.type,
        sessions: Number(row.sessions || 0),
        avgAccuracy: Number(row.avgAccuracy || 0),
        severity: row.avgAccuracy < 60 ? 'high' : 'medium',
        reason: `Low accuracy (${row.avgAccuracy}%).`,
        recommendation: `Practice more ${row.type} sessions and review missed items.`,
      });
    }
    // Only flag low activity if there is no accuracy gap already flagged for this type
    if (row.sessions < 3 && !hasAccuracyGap) {
      gaps.push({
        type: row.type,
        sessions: Number(row.sessions || 0),
        avgAccuracy: Number(row.avgAccuracy || 0),
        severity: 'low',
        reason: `Low activity (${row.sessions} session${row.sessions === 1 ? '' : 's'}).`,
        recommendation: `Increase ${row.type} practice frequency this week.`,
      });
    }
  });

  return gaps.sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity];
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeLevelBand(levelRaw) {
  const level = String(levelRaw || 'auto').trim().toUpperCase();
  const bands = {
    A1: { label: 'A1 Beginner', min: 1, max: 2 },
    A2: { label: 'A2 Elementary', min: 2, max: 3 },
    B1: { label: 'B1 Intermediate', min: 3, max: 4 },
    B2: { label: 'B2 Upper-Intermediate', min: 3, max: 5 },
    C1: { label: 'C1 Advanced', min: 4, max: 5 },
    C2: { label: 'C2 Proficient', min: 5, max: 5 },
  };
  return bands[level] || null;
}

function inferAutoBandFromLevel(levelValue) {
  const level = Math.max(1, Number(levelValue || 1));
  if (level <= 6) return { key: 'A1', label: 'A1 Beginner', min: 1, max: 2 };
  if (level <= 12) return { key: 'A2', label: 'A2 Elementary', min: 2, max: 3 };
  if (level <= 22) return { key: 'B1', label: 'B1 Intermediate', min: 3, max: 4 };
  if (level <= 35) return { key: 'B2', label: 'B2 Upper-Intermediate', min: 3, max: 5 };
  if (level <= 55) return { key: 'C1', label: 'C1 Advanced', min: 4, max: 5 };
  return { key: 'C2', label: 'C2 Proficient', min: 5, max: 5 };
}

function normalizeDifficultyBand({ targetLevel, minDifficulty, maxDifficulty, inferredLevel }) {
  const levelBand = normalizeLevelBand(targetLevel);
  const inferredLevelBand = normalizeLevelBand(inferredLevel);
  const fallback = inferredLevelBand || inferAutoBandFromLevel(inferredLevel);
  const min = clampNumber(minDifficulty, 1, 5, levelBand ? levelBand.min : fallback.min);
  const max = clampNumber(maxDifficulty, min, 5, levelBand ? levelBand.max : fallback.max);
  const resolvedLevel = levelBand
    ? String(targetLevel).toUpperCase()
    : (inferredLevelBand ? String(inferredLevel).toUpperCase() : 'AUTO');
  return {
    level: resolvedLevel,
    label: levelBand ? levelBand.label : fallback.label,
    min,
    max,
  };
}

function buildExerciseMix(minutes, accuracy, streak) {
  const safeMinutes = Math.max(10, Math.round(minutes));
  let weights = {
    flashcards: 0.4,
    quiz: 0.25,
    matching: 0.2,
    spelling: 0.15,
  };

  if (accuracy < 70) {
    weights = { flashcards: 0.5, quiz: 0.2, matching: 0.2, spelling: 0.1 };
  } else if (accuracy >= 85 && streak >= 3) {
    weights = { flashcards: 0.3, quiz: 0.32, matching: 0.23, spelling: 0.15 };
  }

  const keys = Object.keys(weights);
  const blocks = keys.map((key) => ({
    mode: key,
    minutes: Math.max(1, Math.round(safeMinutes * weights[key])),
  }));

  const allocated = blocks.reduce((sum, item) => sum + item.minutes, 0);
  const delta = safeMinutes - allocated;
  if (delta !== 0) {
    blocks[0].minutes = Math.max(1, blocks[0].minutes + delta);
  }

  return blocks;
}

function wordWeaknessScore(word) {
  const reviewed = Math.max(Number(word?.timesReviewed || 0), 0);
  const correct = Math.max(Number(word?.timesCorrect || 0), 0);
  if (!reviewed) return 0.65;
  const errorRate = Math.max(0, Math.min(1, 1 - (correct / reviewed)));
  const recencyBoost = word?.lastReviewedAt ? 0 : 0.15;
  return Number((errorRate + recencyBoost).toFixed(4));
}

function wordLearningRate(word) {
  const attempts = Math.max(
    asNonNegativeNumber(word?.adaptiveMetrics?.attempts, 0),
    asNonNegativeNumber(word?.timesReviewed, 0)
  );
  const correct = Math.max(
    asNonNegativeNumber(word?.adaptiveMetrics?.correct, 0),
    asNonNegativeNumber(word?.timesCorrect, 0)
  );
  if (!attempts) return 0;
  return Number(Math.max(0, Math.min(1, correct / attempts)).toFixed(4));
}

function normalizePlanLearningStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'mastered') return 'mastered';
  if (raw === 'in_progress' || raw === 'review') return 'review';
  if (raw === 'locked' || raw === 'new') return 'new';
  if (raw === 'struggling') return 'struggling';
  return 'review';
}

function getWordAdaptiveAccuracy(word) {
  const attempts = asNonNegativeNumber(word?.adaptiveMetrics?.attempts, 0);
  const correct = asNonNegativeNumber(word?.adaptiveMetrics?.correct, 0);
  const reviewed = Math.max(attempts, asNonNegativeNumber(word?.timesReviewed, 0));
  const hits = Math.max(correct, asNonNegativeNumber(word?.timesCorrect, 0));
  if (!reviewed) return null;
  return hits / Math.max(reviewed, 1);
}

function isWordDueReview(word) {
  const dueAt = word?.adaptiveMetrics?.dueAt || word?.nextReviewAt;
  if (!dueAt) return false;
  const date = new Date(dueAt);
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now();
}

function resolveWordItemDifficulty(word) {
  if (Number.isFinite(Number(word?.adaptiveMetrics?.itemDifficulty))) {
    return asBoundedNumber(word.adaptiveMetrics.itemDifficulty, 0, 100, 50);
  }
  return normalizeItemDifficulty(clampNumber(word?.difficulty, 1, 5, 3));
}

function buildWordPlanSource(word, band, abilityScore = 0) {
  const itemDifficulty = resolveWordItemDifficulty(word);
  const difficulty = Number((1 + (itemDifficulty / 100) * 4).toFixed(2));
  const inBand = difficulty >= Number(band?.min || 1) && difficulty <= Number(band?.max || 5);
  const status = normalizePlanLearningStatus(word?.learningStatus);
  const accuracy = getWordAdaptiveAccuracy(word);
  const expected = expectedSuccess(abilityScore, itemDifficulty);
  const struggling = status === 'struggling' || (accuracy !== null && accuracy < 0.55 && asNonNegativeNumber(word?.timesReviewed, 0) >= 2);
  const dueReview = isWordDueReview(word) || status === 'review';
  const isNew = status === 'new' || asNonNegativeNumber(word?.timesReviewed, 0) === 0;
  const source = struggling
    ? 'remediation'
    : dueReview
      ? 'due_review'
      : isNew
        ? 'new'
        : inBand
          ? 'growth'
          : 'stretch';

  return {
    source,
    difficulty,
    itemDifficulty,
    inBand,
    status,
    accuracy,
    expectedSuccess: expected,
    dueReview,
    struggling,
    isNew,
  };
}

function rankPlanWords(words, band, planProfile) {
  const abilityScore = asBoundedNumber(planProfile?.abilityScore, 0, 100, 0);
  const ranked = (Array.isArray(words) ? words : []).map((item) => {
    const planMeta = buildWordPlanSource(item, band, abilityScore);
    const remediationBoost = planMeta.source === 'remediation' ? 0.85 : 0;
    const dueBoost = planMeta.source === 'due_review' ? 0.65 : 0;
    const newBoost = planMeta.source === 'new' ? 0.25 : 0;
    const outOfBandPenalty = planMeta.inBand ? 0 : 0.45;
    const expectedGap = Math.abs((planMeta.expectedSuccess || 0.5) - 0.72);
    const expectedCalibration = 1 - Math.min(1, expectedGap / 0.72);
    const expectedCalibrationBoost = (expectedCalibration - 0.5) * 0.45;
    const lowHeartPenalty = planProfile?.heartState?.lowHearts && planMeta.source === 'stretch' ? 0.55 : 0;
    return {
      ...item,
      _planMeta: planMeta,
      _rank: {
        learningRate: wordLearningRate(item),
        weakness: wordWeaknessScore(item) + remediationBoost + dueBoost + newBoost + expectedCalibrationBoost - outOfBandPenalty - lowHeartPenalty,
        reviewed: Math.max(Number(item?.timesReviewed || 0), 0),
        difficulty: planMeta.difficulty,
        random: Math.random(),
      },
    };
  });

  ranked.sort((a, b) => {
    if (a._rank.learningRate !== b._rank.learningRate) return a._rank.learningRate - b._rank.learningRate;
    if (b._rank.weakness !== a._rank.weakness) return b._rank.weakness - a._rank.weakness;
    if (a._planMeta.source !== b._planMeta.source) {
      const order = { remediation: 0, due_review: 1, review: 2, new: 3, growth: 4, stretch: 5 };
      return (order[a._planMeta.source] ?? 9) - (order[b._planMeta.source] ?? 9);
    }
    if (a._rank.reviewed !== b._rank.reviewed) return a._rank.reviewed - b._rank.reviewed;
    if (b._rank.difficulty !== a._rank.difficulty) return b._rank.difficulty - a._rank.difficulty;
    return a._rank.random - b._rank.random;
  });

  return ranked;
}

function selectPlanWordsWithMix(words, wordCount, band, planProfile) {
  const ranked = rankPlanWords(words, band, planProfile);
  const queue = buildAdaptiveQueue(
    planProfile?.snapshot?.userId || planProfile?.userId || '',
    {
      pool: ranked,
      wordCount: Math.max(1, asNonNegativeNumber(wordCount, 1)),
      currentPct: 0.7,
      stretchPct: 0.2,
      reviewPct: 0.1,
    }
  );

  const selectedWords = queue.queue.map((w) => {
    const { _rank, ...plain } = w;
    return plain;
  });

  return {
    selectedWords,
    queueMix: {
      totalRequested: queue.totalRequested,
      targetCounts: queue.targetCounts,
      counts: queue.counts,
      ratios: queue.ratios,
    },
  };
}

function selectPlanWords(words, wordCount, band, planProfile) {
  return selectPlanWordsWithMix(words, wordCount, band, planProfile).selectedWords;
}

function summarizeQueueSources(words = []) {
  const summary = {
    dueReviewCount: 0,
    remediationCount: 0,
  };
  (Array.isArray(words) ? words : []).forEach((item) => {
    const source = String(item?._planMeta?.source || item?.source || '').toLowerCase();
    if (source === 'due_review') summary.dueReviewCount += 1;
    if (source === 'remediation') summary.remediationCount += 1;
  });
  return summary;
}

function buildQueueFallbackImageUrl(word, definition = '') {
  if (typeof wordsRoute.buildFallbackImageUrl === 'function') {
    return wordsRoute.buildFallbackImageUrl(word, definition);
  }

  const raw = `${String(word || '')} ${String(definition || '')}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .slice(0, 3);

  const tags = raw.length ? raw.join(',') : 'vocabulary';
  return `https://loremflickr.com/900/560/${tags}`;
}

function serializeSelectedWords(selectedWords, limit = 200) {
  return (Array.isArray(selectedWords) ? selectedWords : [])
    .slice(0, Math.max(1, Number(limit) || 200))
    .map((word) => ({
      ...word,
      expectedSuccess: typeof word?._planMeta?.expectedSuccess === 'number'
        ? word._planMeta.expectedSuccess
        : null,
    }));
}

async function resolvePlanWordOwners(userId) {
  if (GLOBAL_WORD_SCOPE) {
    return ['*'];
  }

  if (!isDbConnected()) {
    const store = devStore.readStore();
    const user = (store.users || []).find((entry) => String(entry._id) === String(userId));
    if (!user) return [];
    if (String(user.role || 'student') === 'student') {
      return (store.users || [])
        .filter((entry) => String(entry.role || 'student') === 'creator')
        .map((entry) => String(entry._id));
    }
    return [String(user._id)];
  }

  const user = await User.findById(userId).select('role creatorCode linkedCreatorCode').lean();
  if (!user) return [];
  if (String(user.role || 'student') === 'student') {
    const creators = await User.find({ role: 'creator' }).select('_id').lean();
    return creators.map((entry) => String(entry._id));
  }
  return [String(user._id)];
}

async function readPlanWordsForOwners(ownerIds) {
  const owners = Array.isArray(ownerIds) ? ownerIds.map((id) => String(id)).filter(Boolean) : [];
  if (!owners.length) return [];
  const useGlobal = owners.includes('*');
  const isGeneralWord = (word) => {
    const hasDeck = String(word && word.deckId || '').trim().length > 0;
    const domain = String(word && word.domain || '').trim().toLowerCase();
    return !hasDeck && domain !== 'deck';
  };

  if (!isDbConnected()) {
    const store = devStore.readStore();
    const scoped = useGlobal
      ? (store.words || [])
      : (store.words || []).filter((word) => owners.includes(String(word.userId)));
    return scoped.filter(isGeneralWord);
  }

  const query = useGlobal ? {} : { userId: { $in: owners } };
  query.$or = [{ deckId: null }, { deckId: { $exists: false } }];
  query.domain = { $ne: 'deck' };
  const docs = await Word.find(query).select('word definition example difficulty timesReviewed timesCorrect lastReviewedAt nextReviewAt imageUrl learningStatus targetScoreRange tags domain deckId createdAt updatedAt adaptiveMetrics').lean();
  return docs || [];
}

// All routes require authentication
router.use(auth);

// GET /api/progress - Get user's progress
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const cacheKey = `progress:profile:${userId}`;

    const progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      }

      let doc = await Progress.findOne({ userId });
      if (!doc) {
        doc = createEmptyProgress(userId);
      }
      return doc;
    });

    return res.json(progress);
  } catch (err) {
    console.error('Error fetching progress:', err);
    res.status(500).json({ message: 'Failed to fetch progress' });
  }
});

// POST /api/progress - Save session progress
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { sessionType } = req.body;
    const xpEarnedValue = asNonNegativeNumber(req.body.xpEarned, 0);
    const accuracyValue = asBoundedNumber(req.body.accuracy, 0, 100, 0);
    const wordsCompletedValue = asNonNegativeNumber(req.body.wordsCompleted, 0);
    const durationValue = Math.round(asNonNegativeNumber(req.body.duration, 0));

    if (!isDbConnected()) {
      const progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      const beforeSnapshot = normalizeProgressSnapshot(progress, userId);

      const previousLessonsCompleted = asNonNegativeNumber(progress.lessonsCompleted, 0);
      const previousAccuracy = asBoundedNumber(progress.accuracy, 0, 100, 0);
      const previousWordsLearned = asNonNegativeNumber(progress.wordsLearned, 0);
      progress.totalXP += xpEarnedValue;
      progress.lessonsCompleted = previousLessonsCompleted + 1;
      progress.accuracy = previousLessonsCompleted === 0
        ? accuracyValue
        : Number(((previousAccuracy * previousLessonsCompleted + accuracyValue) / progress.lessonsCompleted).toFixed(2));
      progress.wordsLearned = previousWordsLearned + wordsCompletedValue;
      progress.totalStudyTime = (progress.totalStudyTime || 0) + durationValue;
      progress.longestStreak = Math.max(progress.longestStreak || 0, progress.streak || 0);
      progress.lastActivityDate = new Date();
      progress.completedLessons.push({
        type: sessionType,
        date: new Date(),
        xp: xpEarnedValue,
        accuracy: accuracyValue,
        duration: durationValue,
      });
      if (!Array.isArray(progress.dailyHistory)) {
        progress.dailyHistory = [];
      }
      applyDailyHistoryUpdate(progress, {
        sessionType,
        xpEarned: xpEarnedValue,
        wordsCompleted: wordsCompletedValue,
        accuracy: accuracyValue,
        durationValue,
      });
      updateBehaviorSignals(progress, {
        attempts: Array.isArray(req.body?.attempts) ? req.body.attempts : [],
      });
      updateAdaptiveProfileFromSession(progress, {
        accuracy: accuracyValue,
        xpEarned: xpEarnedValue,
        wordsCompleted: wordsCompletedValue,
        attempts: Array.isArray(req.body?.attempts) ? req.body.attempts : [],
        averageLatencyMs: req.body?.averageLatencyMs,
      });
      applyDerivedProgressMetrics(progress);

      devStore.saveProgress(userId, progress);
      clearByPrefix(progressCache, 'progress:');
      const afterSnapshot = normalizeProgressSnapshot(progress, userId);
      return res.json({
        message: 'Progress saved',
        progress,
        level: buildLevelPayload(afterSnapshot.totalXP),
        gamification: buildGamificationDelta(beforeSnapshot, afterSnapshot, xpEarnedValue),
      });
    }

    let progress = await Progress.findOne({ userId });
    if (!progress) {
      progress = new Progress({
        ...createEmptyProgress(userId),
      });
    }
    const beforeSnapshot = normalizeProgressSnapshot(progress.toObject ? progress.toObject() : progress, userId);

    const previousLessonsCompleted = asNonNegativeNumber(progress.lessonsCompleted, 0);
    const previousAccuracy = asBoundedNumber(progress.accuracy, 0, 100, 0);
    const previousWordsLearned = asNonNegativeNumber(progress.wordsLearned, 0);
    progress.totalXP += xpEarnedValue;
    progress.lessonsCompleted = previousLessonsCompleted + 1;
    progress.accuracy = previousLessonsCompleted === 0
      ? accuracyValue
      : Number(((previousAccuracy * previousLessonsCompleted + accuracyValue) / progress.lessonsCompleted).toFixed(2));
    progress.wordsLearned = previousWordsLearned + wordsCompletedValue;
    progress.totalStudyTime = (progress.totalStudyTime || 0) + durationValue;
    progress.longestStreak = Math.max(progress.longestStreak || 0, progress.streak || 0);
    progress.lastActivityDate = new Date();
    progress.completedLessons.push({
      type: sessionType,
      date: new Date(),
      xp: xpEarnedValue,
      accuracy: accuracyValue,
      duration: durationValue,
    });
    if (!Array.isArray(progress.dailyHistory)) {
      progress.dailyHistory = [];
    }
    applyDailyHistoryUpdate(progress, {
      sessionType,
      xpEarned: xpEarnedValue,
      wordsCompleted: wordsCompletedValue,
      accuracy: accuracyValue,
      durationValue,
    });
    updateBehaviorSignals(progress, {
      attempts: Array.isArray(req.body?.attempts) ? req.body.attempts : [],
    });
    updateAdaptiveProfileFromSession(progress, {
      accuracy: accuracyValue,
      xpEarned: xpEarnedValue,
      wordsCompleted: wordsCompletedValue,
      attempts: Array.isArray(req.body?.attempts) ? req.body.attempts : [],
      averageLatencyMs: req.body?.averageLatencyMs,
    });
    applyDerivedProgressMetrics(progress);

    await progress.save();
    clearByPrefix(progressCache, 'progress:');
    const afterSnapshot = normalizeProgressSnapshot(progress.toObject ? progress.toObject() : progress, userId);
    res.json({
      message: 'Progress saved',
      progress,
      level: buildLevelPayload(afterSnapshot.totalXP),
      gamification: buildGamificationDelta(beforeSnapshot, afterSnapshot, xpEarnedValue),
    });
  } catch (err) {
    console.error('Error saving progress:', err);
    res.status(500).json({ message: 'Failed to save progress' });
  }
});

// GET /api/progress/study-plan - Adaptive daily study plan with level/time/word targeting
router.get('/study-plan', async (req, res) => {
  try {
    const userId = req.user.id;
    const minutes = clampNumber(req.query.minutes, 10, 120, 20);
    const desiredWordCount = clampNumber(req.query.wordCount, 5, 60, Math.max(8, Math.round(minutes * 0.8)));
    const hearts = clampNumber(req.query.hearts, 0, 5, 5);
    const targetLevelQuery = String(req.query.targetLevel || 'AUTO').toUpperCase();

    let progress = null;
    const cacheKey = `progress:study-plan:${userId}:${minutes}:${desiredWordCount}:${hearts}:${targetLevelQuery}`;

    progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId);
      }
      return Progress.findOne({ userId }).lean();
    });

    const snapshot = normalizeProgressSnapshot(progress, userId);
    const planProfile = buildDailyPlanFromProfile(snapshot, {
      minutes,
      wordCount: desiredWordCount,
      hearts,
    });
    const userLevelPayload = buildLevelPayload(snapshot.totalXP);
    const requestedMode = String(req.query.mode || '').toLowerCase();
    const band = normalizeDifficultyBand({
      targetLevel: req.query.targetLevel,
      minDifficulty: req.query.minDifficulty,
      maxDifficulty: req.query.maxDifficulty,
      inferredLevel: userLevelPayload.level,
    });

    const ownerIds = await resolvePlanWordOwners(userId);
    const words = await readPlanWordsForOwners(ownerIds);
    planProfile.dueReviews = words.filter((word) => isWordDueReview(word)).length;
    planProfile.snapshot = snapshot;
    applyMasteryGates(planProfile);
    applyRemediation(planProfile, { words });
    ensureStudyPlanPersonalizationContract(planProfile);
    const modeAccess = enforceModeAccess(planProfile, requestedMode);
    if (modeAccess) {
      planProfile.modeAccess = modeAccess;
      return res.status(403).json({ message: 'Requested mode is locked', mode: modeAccess.requestedMode, reason: modeAccess.reason, fallbackMode: modeAccess.fallbackMode, plan: planProfile });
    }
    const queueResult = selectPlanWordsWithMix(words, planProfile.targetWordCount, band, planProfile);
    const selectedWords = queueResult.selectedWords;
    const sourceSummary = summarizeQueueSources(selectedWords);
    planProfile.adaptiveQueue = planProfile.adaptiveQueue || {};
    planProfile.adaptiveQueue.mix = queueResult.queueMix;
    planProfile.adaptiveQueue.targetWords = selectedWords.length;
    planProfile.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
    planProfile.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
    planProfile.progression = buildProgressionUnlockState(snapshot, selectedWords, planProfile);
    finalizeExerciseMix(planProfile, { lowHeartsBoostMode: 'flashcards' });
    // attach a lightweight preview for client-side queue rendering
    planProfile.adaptiveQueue.queuePreview = selectedWords.slice(0, 10).map((w, i) => ({
      wordId: String(w._id || w.wordId || w.word || ''),
      word: String(w.word || ''),
      difficulty: asBoundedNumber(w.difficulty, 1, 5, 3),
      source: String(w._planMeta?.source || 'general'),
      position: i,
    }));
    
      // Auto-start option: if requested, persist the plan as an active queue and return queue metadata
      if (String(req.query.autoStart || '').toLowerCase() === 'true') {
        const prefs = { minutes, wordCount: desiredWordCount, hearts, targetLevel: targetLevelQuery, mode: requestedMode };
        const startResult = await startQueueForUser(userId, prefs);
        if (startResult?.blocked) {
          return res.status(403).json({ message: 'Requested mode is locked', mode: startResult.requestedMode, reason: startResult.reason, fallbackMode: startResult.fallbackMode, plan: planProfile });
        }
        return res.json({ plan: planProfile, selectedWords: serializeSelectedWords(selectedWords, 200), autoStarted: true, queue: { queueId: startResult.queueId, planId: startResult.planId, totalItems: startResult.totalItems } });
      }

      // Note: clients should call /api/progress/queue/start to persist this plan as an active queue
      return res.json({
        plan: planProfile,
        selectedWords: serializeSelectedWords(selectedWords, 200),
      });
    } catch (err) {
      console.error('Error building study plan:', err);
      return res.status(500).json({ message: 'Failed to build study plan' });
    }
  });

  // ---------------------------
  // Queue lifecycle endpoints
  // ---------------------------

  // POST /api/progress/queue/start
  router.post('/queue/start', async (req, res) => {
    try {
      const userId = req.user.id;
      const prefs = req.body || {};
      // build plan snapshot using existing study-plan helpers
      let progress = null;
      if (!isDbConnected()) progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      else progress = await Progress.findOne({ userId }) || createEmptyProgress(userId);

      const snapshot = normalizeProgressSnapshot(progress, userId);
      const planProfile = buildDailyPlanFromProfile(snapshot, prefs);
      const requestedMode = String(prefs.mode || req.body?.mode || '').toLowerCase();
      applyMasteryGates(planProfile);
      const ownerIds = await resolvePlanWordOwners(userId);
      const words = await readPlanWordsForOwners(ownerIds);
      applyRemediation(planProfile, { words });
      const modeAccess = enforceModeAccess(planProfile, requestedMode);
      if (modeAccess) {
        return res.status(403).json({ message: 'Requested mode is locked', mode: modeAccess.requestedMode, reason: modeAccess.reason, fallbackMode: modeAccess.fallbackMode, plan: planProfile });
      }
      const band = normalizeDifficultyBand({ inferredLevel: snapshot.adaptiveProfile.targetLevel });
      const queueResult = selectPlanWordsWithMix(words, planProfile.targetWordCount, band, planProfile);
      const selected = queueResult.selectedWords;
      const sourceSummary = summarizeQueueSources(selected);
      planProfile.adaptiveQueue = planProfile.adaptiveQueue || {};
      planProfile.adaptiveQueue.mix = queueResult.queueMix;
      planProfile.adaptiveQueue.targetWords = selected.length;
      planProfile.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
      planProfile.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
      planProfile.progression = buildProgressionUnlockState(snapshot, selected, planProfile);

      const queueLookupKey = (word, definition) => `${String(word || '').trim().toLowerCase()}::${String(definition || '').trim().toLowerCase()}`;
      const canonicalById = new Map((words || []).map((entry) => [String(entry?._id || entry?.wordId || ''), entry]));
      const canonicalByKey = new Map((words || []).map((entry) => [queueLookupKey(entry?.word, entry?.definition), entry]));

      // build immutable items
      const items = (selected || []).map((w, idx) => {
        const selectedWordId = String(w?._id || w?.wordId || '');
        const canonical = canonicalById.get(selectedWordId) || canonicalByKey.get(queueLookupKey(w?.word, w?.definition)) || w || {};
        return ({
        queueItemId: crypto.randomBytes(6).toString('hex'),
        position: idx,
        wordId: String(canonical._id || canonical.wordId || selectedWordId || ''),
        word: String(canonical.word || w.word || ''),
        definition: String(canonical.definition || w.definition || ''),
        hint: String(w.example || canonical.example || ''),
        imageUrl: String(w.imageUrl || canonical.imageUrl || buildQueueFallbackImageUrl(canonical.word || w.word, canonical.definition || w.definition)),
        difficulty: asBoundedNumber(w.difficulty, 1, 5, 3),
        source: String(w._planMeta?.source || 'general'),
        status: 'pending',
        attempts: 0,
        correctAttempts: 0,
        latencyMsAvg: 0,
        lastLatencyMs: 0,
        behavior: null,
        requeueCount: 0,
        lastMode: null,
        lastAttemptAt: null,
      });
      });

      const planId = crypto.createHash('sha1').update(JSON.stringify({ userId, prefs, profile: planProfile })).digest('hex').slice(0, 12);
      const queueId = crypto.randomBytes(8).toString('hex');
      const now = new Date().toISOString();
      const activeQueue = {
        planId,
        queueId,
        status: 'active',
        version: 1,
        createdAt: now,
        expiresAt: new Date(Date.now() + (1000 * 60 * 60 * 6)).toISOString(), // 6 hours
        settings: {
          minutes: clampNumber(prefs.minutes, 10, 120, planProfile.prefs.minutes || 20),
          wordCount: clampNumber(prefs.wordCount, 5, 60, planProfile.prefs.wordCount || planProfile.targetWordCount),
          targetLevel: String(prefs.targetLevel || planProfile.prefs.targetLevel || 'AUTO').toUpperCase(),
          hearts: clampNumber(prefs.hearts, 0, 5, planProfile.prefs.hearts || 5),
          difficultyBand: { min: band.min, max: band.max, label: band.label, level: band.level },
        },
        cursor: { nextIndex: 0, completedCount: 0 },
        modeProgress: { flashcards: 0, quiz: 0, matching: 0, spelling: 0 },
        items,
        attemptLedger: [],
      };

      // persist into progress
      if (!isDbConnected()) {
        progress.adaptiveQueue = progress.adaptiveQueue || {};
        progress.adaptiveQueue.generatedAt = now;
        progress.adaptiveQueue.targetWords = items.length;
        progress.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
        progress.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
        progress.adaptiveQueue.mix = queueResult.queueMix;
        progress.adaptiveQueue.queuePreview = items.slice(0, 12).map((it) => ({ wordId: it.wordId, word: it.word, hint: it.hint, imageUrl: it.imageUrl, difficulty: it.difficulty, source: it.source, position: it.position }));
        progress.adaptiveQueue.activeQueue = activeQueue;
        devStore.saveProgress(userId, progress);
      } else {
        let doc = await Progress.findOne({ userId });
        if (!doc) {
          doc = new Progress({ ...createEmptyProgress(userId) });
        }
        doc.adaptiveQueue = doc.adaptiveQueue || {};
        doc.adaptiveQueue.generatedAt = now;
        doc.adaptiveQueue.targetWords = items.length;
        doc.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
        doc.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
        doc.adaptiveQueue.mix = queueResult.queueMix;
        doc.adaptiveQueue.queuePreview = items.slice(0, 12).map((it) => ({ wordId: it.wordId, word: it.word, hint: it.hint, imageUrl: it.imageUrl, difficulty: it.difficulty, source: it.source, position: it.position }));
        doc.adaptiveQueue.activeQueue = activeQueue;
        await doc.save();
      }
      clearByPrefix(progressCache, 'progress:');

      return res.json({
        message: 'Queue started',
        planId,
        queueId,
        totalItems: items.length,
        nextIndex: 0,
        preview: items.slice(0, 6),
        mix: queueResult.queueMix,
        dueReviewCount: sourceSummary.dueReviewCount,
        remediationCount: sourceSummary.remediationCount,
        settings: activeQueue.settings,
      });
    } catch (err) {
      console.error('Error starting queue:', err);
      return res.status(500).json({ message: 'Failed to start queue' });
    }
  });

  // helper: build and persist a queue for a user (returns saved activeQueue metadata)
  async function startQueueForUser(userId, prefs = {}) {
    const snapshot = normalizeProgressSnapshot(await (isDbConnected() ? Progress.findOne({ userId }).lean() : devStore.getProgressByUser(userId)), userId);
    const planProfile = buildDailyPlanFromProfile(snapshot, prefs);
    const requestedMode = String((prefs && typeof prefs === 'object' ? prefs.mode : '') || '').toLowerCase();
    applyMasteryGates(planProfile);
    const ownerIds = await resolvePlanWordOwners(userId);
    const words = await readPlanWordsForOwners(ownerIds);
    applyRemediation(planProfile, { words });
    const modeAccess = enforceModeAccess(planProfile, requestedMode);
    if (modeAccess) {
      return { blocked: true, requestedMode: modeAccess.requestedMode, fallbackMode: modeAccess.fallbackMode, reason: modeAccess.reason, plan: planProfile };
    }
    const band = normalizeDifficultyBand({ inferredLevel: snapshot.adaptiveProfile.targetLevel });
    const queueResult = selectPlanWordsWithMix(words, planProfile.targetWordCount, band, planProfile);
    const selected = queueResult.selectedWords;
    const sourceSummary = summarizeQueueSources(selected);
    planProfile.adaptiveQueue = planProfile.adaptiveQueue || {};
    planProfile.adaptiveQueue.mix = queueResult.queueMix;
    planProfile.adaptiveQueue.targetWords = selected.length;
    planProfile.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
    planProfile.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
    planProfile.progression = buildProgressionUnlockState(snapshot, selected, planProfile);

    const queueLookupKey = (word, definition) => `${String(word || '').trim().toLowerCase()}::${String(definition || '').trim().toLowerCase()}`;
    const canonicalById = new Map((words || []).map((entry) => [String(entry?._id || entry?.wordId || ''), entry]));
    const canonicalByKey = new Map((words || []).map((entry) => [queueLookupKey(entry?.word, entry?.definition), entry]));

    const items = (selected || []).map((w, idx) => {
      const selectedWordId = String(w?._id || w?.wordId || '');
      const canonical = canonicalById.get(selectedWordId) || canonicalByKey.get(queueLookupKey(w?.word, w?.definition)) || w || {};
      return ({
      queueItemId: crypto.randomBytes(6).toString('hex'),
      position: idx,
      wordId: String(canonical._id || canonical.wordId || selectedWordId || ''),
      word: String(canonical.word || w.word || ''),
      definition: String(canonical.definition || w.definition || ''),
      hint: String(w.example || canonical.example || ''),
      imageUrl: String(w.imageUrl || canonical.imageUrl || buildQueueFallbackImageUrl(canonical.word || w.word, canonical.definition || w.definition)),
      difficulty: asBoundedNumber(w.difficulty, 1, 5, 3),
      source: String(w._planMeta?.source || 'general'),
      status: 'pending',
      attempts: 0,
      correctAttempts: 0,
      latencyMsAvg: 0,
      lastLatencyMs: 0,
      behavior: null,
      learningStatus: 'new',
      requeueCount: 0,
      lastMode: null,
      lastAttemptAt: null,
    });
    });

    const planId = crypto.createHash('sha1').update(JSON.stringify({ userId, prefs, profile: planProfile })).digest('hex').slice(0, 12);
    const queueId = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const activeQueue = {
      planId,
      queueId,
      status: 'active',
      version: 1,
      createdAt: now,
      expiresAt: new Date(Date.now() + (1000 * 60 * 60 * 6)).toISOString(), // 6 hours
      settings: {
        minutes: clampNumber(prefs.minutes, 10, 120, planProfile.prefs.minutes || 20),
        wordCount: clampNumber(prefs.wordCount, 5, 60, planProfile.prefs.wordCount || planProfile.targetWordCount),
        targetLevel: String(prefs.targetLevel || planProfile.prefs.targetLevel || 'AUTO').toUpperCase(),
        hearts: clampNumber(prefs.hearts, 0, 5, planProfile.prefs.hearts || 5),
        difficultyBand: { min: band.min, max: band.max, label: band.label, level: band.level },
      },
      cursor: { nextIndex: 0, completedCount: 0 },
      modeProgress: { flashcards: 0, quiz: 0, matching: 0, spelling: 0 },
      items,
      attemptLedger: [],
    };
    // persist into progress
    if (!isDbConnected()) {
      let progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      progress.adaptiveQueue = progress.adaptiveQueue || {};
      progress.adaptiveQueue.generatedAt = now;
      progress.adaptiveQueue.targetWords = items.length;
      progress.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
      progress.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
      progress.adaptiveQueue.mix = queueResult.queueMix;
      progress.adaptiveQueue.queuePreview = items.slice(0, 12).map((it) => ({ wordId: it.wordId, word: it.word, hint: it.hint, imageUrl: it.imageUrl, difficulty: it.difficulty, source: it.source, position: it.position }));
      progress.adaptiveQueue.activeQueue = activeQueue;
      devStore.saveProgress(userId, progress);
      clearByPrefix(progressCache, 'progress:');
      return { activeQueue, planId, queueId, totalItems: items.length };
    }

    let doc = await Progress.findOne({ userId });
    if (!doc) {
      doc = new Progress({ ...createEmptyProgress(userId) });
    }
    doc.adaptiveQueue = doc.adaptiveQueue || {};
    doc.adaptiveQueue.generatedAt = now;
    doc.adaptiveQueue.targetWords = items.length;
    doc.adaptiveQueue.dueReviewCount = sourceSummary.dueReviewCount;
    doc.adaptiveQueue.remediationCount = sourceSummary.remediationCount;
    doc.adaptiveQueue.mix = queueResult.queueMix;
    doc.adaptiveQueue.queuePreview = items.slice(0, 12).map((it) => ({ wordId: it.wordId, word: it.word, hint: it.hint, imageUrl: it.imageUrl, difficulty: it.difficulty, source: it.source, position: it.position }));
    doc.adaptiveQueue.activeQueue = activeQueue;
    await doc.save();
    clearByPrefix(progressCache, 'progress:');
    return { activeQueue, planId, queueId, totalItems: items.length };
  }

  // GET /api/progress/queue/current
  router.get('/queue/current', async (req, res) => {
    try {
      const userId = req.user.id;
      let progress = null;
      if (!isDbConnected()) progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      else progress = await Progress.findOne({ userId }) || createEmptyProgress(userId);

      const snapshot = normalizeProgressSnapshot(progress, userId);
      return res.json({ activeQueue: snapshot.adaptiveQueue.activeQueue || null });
    } catch (err) {
      console.error('Error getting current queue:', err);
      return res.status(500).json({ message: 'Failed to fetch current queue' });
    }
  });

  // GET /api/progress/queue/next - peek next item without advancing
  router.get('/queue/next', async (req, res) => {
    try {
      const userId = req.user.id;
      let progress = null;
      if (!isDbConnected()) progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      else progress = await Progress.findOne({ userId }) || createEmptyProgress(userId);

      const active = progress?.adaptiveQueue?.activeQueue || null;
      if (!active || !Array.isArray(active.items) || active.items.length === 0) return res.status(404).json({ message: 'No active queue' });
      const idx = Math.max(0, active.cursor?.nextIndex || 0);
      const item = active.items[idx] || null;
      return res.json({ nextIndex: idx, item });
    } catch (err) {
      console.error('Error peeking next queue item:', err);
      return res.status(500).json({ message: 'Failed to peek next item' });
    }
  });

  // POST /api/progress/queue/attempt - submit attempt and atomically advance cursor
  router.post('/queue/attempt', async (req, res) => {
    try {
      const userId = req.user.id;
      const { queueId, queueItemId, mode, correctness, latencyMs, idempotencyKey, expectedVersion, expectedPosition } = req.body || {};
      if (!queueId || !queueItemId) return res.status(400).json({ message: 'queueId and queueItemId required' });

      // load progress
      let progress = null;
      if (!isDbConnected()) {
        progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
        const active = progress?.adaptiveQueue?.activeQueue || null;
        if (!active || String(active.queueId) !== String(queueId)) return res.status(409).json({ message: 'Active queue mismatch' });

        // idempotency check before version enforcement so replayed requests can still be detected
        if (Array.isArray(active.attemptLedger)) {
          const existing = active.attemptLedger.find((e) => e.idempotencyKey && idempotencyKey && e.idempotencyKey === idempotencyKey);
          if (existing) return res.json({ replay: true, entry: existing });
        }

        if (expectedVersion && Number(expectedVersion) !== Number(active.version)) return res.status(409).json({ message: 'Version mismatch' });

        const idx = Number(active.cursor?.nextIndex || 0);
        const item = (active.items || [])[idx];
        if (!item || String(item.queueItemId) !== String(queueItemId)) return res.status(409).json({ message: 'Queue item mismatch or already advanced' });
        const isCorrect = normalizeCorrectness(correctness);

        // update item stats
        item.attempts = (Number(item.attempts || 0) + 1);
        if (isCorrect) item.correctAttempts = (Number(item.correctAttempts || 0) + 1);
        const prevAvg = Number(item.latencyMsAvg || 0);
        item.latencyMsAvg = prevAvg === 0 ? Number(latencyMs || 0) : Math.round(((prevAvg * (item.attempts - 1)) + Number(latencyMs || 0)) / item.attempts);
        item.lastLatencyMs = Number(latencyMs || 0);
        item.behavior = classifyAttemptBehavior(latencyMs, isCorrect, progress?.adaptiveProfile?.behaviorSignals?.baselineLatencyMs || 2200);
        item.learningStatus = isCorrect ? 'review' : 'struggling';
        item.lastMode = String(mode || item.lastMode || 'flashcards');
        item.lastAttemptAt = new Date().toISOString();
        item.status = isCorrect ? 'correct' : 'review';

        const advancedTo = idx + 1;
        active.cursor.nextIndex = advancedTo;
        active.cursor.completedCount = Math.max(0, Number(active.cursor.completedCount || 0) + 1);
        const normalizedMode = ['flashcards', 'quiz', 'matching', 'spelling'].includes(String(mode || 'flashcards').toLowerCase())
          ? String(mode || 'flashcards').toLowerCase()
          : 'flashcards';
        active.modeProgress = active.modeProgress || {};
        active.modeProgress[normalizedMode] = Math.max(0, Number(active.modeProgress[normalizedMode] || 0) + 1);

        const behavior = classifyAttemptBehavior(latencyMs, isCorrect, progress?.adaptiveProfile?.behaviorSignals?.baselineLatencyMs || 2200);
        const shouldRetry = shouldRequeueItem(isCorrect, behavior, item.requeueCount);
        const abilityBeforeAttempt = asBoundedNumber(progress?.adaptiveProfile?.abilityScore, 0, 100, 0);
        const itemDifficultyBeforeAttempt = normalizeItemDifficulty(item.difficulty);
        const predictedCorrectRate = expectedSuccess(abilityBeforeAttempt, itemDifficultyBeforeAttempt);
        updateAbilityEstimate(progress, {
          correctness: isCorrect,
          itemDifficulty: itemDifficultyBeforeAttempt,
        }, latencyMs);

        const spacedUpdate = await persistSpacedRepetition(userId, item.wordId, isCorrect, latencyMs, false, {
          correctRate: predictedCorrectRate,
          sampleSize: Math.max(1, Number(item.attempts || 1)),
        });
        if (spacedUpdate && Number.isFinite(Number(spacedUpdate.difficulty))) {
          item.difficulty = asBoundedNumber(spacedUpdate.difficulty, 1, 5, item.difficulty || 3);
        }

        if (shouldRetry) {
          const retryItem = buildRequeueItem(item);
          const retryDelaySlots = computeRetryDelaySlots(isCorrect, item.requeueCount);
          const insertIndex = computeRetryInsertIndex(active.items, advancedTo, retryDelaySlots);
          active.items.splice(insertIndex, 0, retryItem);
        }

        active.items = normalizeQueueItemPositions(active.items);

        const ledgerEntry = {
          idempotencyKey: idempotencyKey || crypto.randomBytes(6).toString('hex'),
          queueItemId: String(queueItemId),
          mode: String(mode || ''),
          behavior,
          accepted: true,
          advancedToIndex: advancedTo,
          version: Number(active.version || 1) + 1,
          response: { accepted: true, advancedToIndex: advancedTo, version: Number(active.version || 1) + 1 },
          createdAt: new Date().toISOString(),
        };

        active.attemptLedger = Array.isArray(active.attemptLedger) ? active.attemptLedger : [];
        active.attemptLedger.push(ledgerEntry);
        // prune ledger to last 150 entries
        active.attemptLedger = active.attemptLedger.slice(-150);
        active.version = Number(active.version || 1) + 1;

        progress.adaptiveQueue = progress.adaptiveQueue || {};
        progress.adaptiveQueue.activeQueue = active;
        devStore.saveProgress(userId, progress);
        clearByPrefix(progressCache, 'progress:');
        return res.json({ accepted: true, ledgerEntry, activeQueue: active });
      }

      // DB mode: perform optimistic atomic update using version filter + arrayFilters
      const doc = await Progress.findOne({ userId }).exec();
      if (!doc) return res.status(404).json({ message: 'Progress not found' });
      const active = doc?.adaptiveQueue?.activeQueue || null;
      if (!active || String(active.queueId) !== String(queueId)) return res.status(409).json({ message: 'Active queue mismatch' });

      // idempotency pre-check (non-DB branch handled above). For DB we will also enforce absence in the update filter.
      if (Array.isArray(active.attemptLedger)) {
        const existing = active.attemptLedger.find((e) => e.idempotencyKey && idempotencyKey && e.idempotencyKey === idempotencyKey);
        if (existing) return res.json({ replay: true, entry: existing });
      }

      if (expectedVersion && Number(expectedVersion) !== Number(active.version)) {
        if (idempotencyKey) {
          const fresh = await Progress.findOne({ userId, 'adaptiveQueue.activeQueue.queueId': queueId }).lean().exec();
          const freshActive = fresh?.adaptiveQueue?.activeQueue || null;
          const replayEntry = Array.isArray(freshActive?.attemptLedger)
            ? freshActive.attemptLedger.find((e) => e && e.idempotencyKey === idempotencyKey)
            : null;
          if (replayEntry) return res.json({ replay: true, entry: replayEntry, activeQueue: freshActive });
        }
        return res.status(409).json({ message: 'Version mismatch' });
      }

      const idx = Number(active.cursor?.nextIndex || 0);
      if (typeof expectedPosition !== 'undefined' && Number(expectedPosition) !== idx) return res.status(409).json({ message: 'Position mismatch' });
      const item = (active.items || [])[idx];
      if (!item || String(item.queueItemId) !== String(queueItemId)) return res.status(409).json({ message: 'Queue item mismatch or already advanced' });

      const isCorrect = normalizeCorrectness(correctness);
      const newAttempts = Number(item.attempts || 0) + 1;
      const newCorrect = Number(item.correctAttempts || 0) + (isCorrect ? 1 : 0);
      const prevAvg = Number(item.latencyMsAvg || 0);
      const newAvg = prevAvg === 0 ? Number(latencyMs || 0) : Math.round(((prevAvg * (newAttempts - 1)) + Number(latencyMs || 0)) / newAttempts);
      const now = new Date().toISOString();
      const advancedTo = idx + 1;
      const baselineLatencyMs = doc?.adaptiveProfile?.behaviorSignals?.baselineLatencyMs || 2200;
      const behavior = classifyAttemptBehavior(latencyMs, isCorrect, baselineLatencyMs);
      const shouldRetry = shouldRequeueItem(isCorrect, behavior, item.requeueCount);
      const abilityBeforeAttempt = asBoundedNumber(doc?.adaptiveProfile?.abilityScore, 0, 100, 0);
      const itemDifficultyBeforeAttempt = normalizeItemDifficulty(item.difficulty);
      const predictedCorrectRate = expectedSuccess(abilityBeforeAttempt, itemDifficultyBeforeAttempt);
      updateAbilityEstimate(doc, {
        correctness: isCorrect,
        itemDifficulty: itemDifficultyBeforeAttempt,
      }, latencyMs);

      const updatedItems = Array.isArray(active.items) ? active.items.map((queueItem, index) => {
        if (index !== idx) return queueItem;
        return {
          ...queueItem,
          attempts: newAttempts,
          correctAttempts: newCorrect,
          latencyMsAvg: newAvg,
          lastLatencyMs: Number(latencyMs || 0),
          behavior,
          learningStatus: isCorrect ? 'review' : 'struggling',
          lastMode: String(mode || queueItem.lastMode || 'flashcards'),
          lastAttemptAt: now,
          status: isCorrect ? 'correct' : 'review',
        };
      }) : [];

      const spacedUpdate = await persistSpacedRepetition(userId, item.wordId, isCorrect, latencyMs, true, {
        correctRate: predictedCorrectRate,
        sampleSize: Math.max(1, newAttempts),
      });
      if (updatedItems[idx] && spacedUpdate && Number.isFinite(Number(spacedUpdate.difficulty))) {
        updatedItems[idx].difficulty = asBoundedNumber(spacedUpdate.difficulty, 1, 5, updatedItems[idx].difficulty || 3);
      }

      if (shouldRetry) {
        const retryItem = buildRequeueItem(updatedItems[idx]);
        const retryDelaySlots = computeRetryDelaySlots(isCorrect, updatedItems[idx].requeueCount);
        const insertIndex = computeRetryInsertIndex(updatedItems, advancedTo, retryDelaySlots);
        updatedItems.splice(insertIndex, 0, retryItem);
      }

      const normalizedItems = normalizeQueueItemPositions(updatedItems);
      const normalizedMode = ['flashcards', 'quiz', 'matching', 'spelling'].includes(String(mode || 'flashcards').toLowerCase())
        ? String(mode || 'flashcards').toLowerCase()
        : 'flashcards';
      const updatedCursor = {
        ...active.cursor,
        nextIndex: advancedTo,
        completedCount: Math.max(0, Number(active.cursor?.completedCount || 0) + 1),
      };
      const updatedModeProgress = {
        ...active.modeProgress,
        [normalizedMode]: Math.max(0, Number(active.modeProgress?.[normalizedMode] || 0) + 1),
      };
      const completedAfterRetry = advancedTo >= normalizedItems.length;

      const ledgerEntry = {
        idempotencyKey: idempotencyKey || crypto.randomBytes(6).toString('hex'),
        queueItemId: String(queueItemId),
        mode: String(mode || ''),
        behavior,
        accepted: true,
        advancedToIndex: advancedTo,
        version: Number(active.version || 1) + 1,
        response: { accepted: true, advancedToIndex: advancedTo, version: Number(active.version || 1) + 1 },
        createdAt: now,
      };

      const filter = {
        userId,
        'adaptiveQueue.activeQueue.queueId': queueId,
        'adaptiveQueue.activeQueue.version': Number(active.version || 1),
      };
      if (idempotencyKey) {
        filter['adaptiveQueue.activeQueue.attemptLedger.idempotencyKey'] = { $ne: idempotencyKey };
      }

      const updatedActive = {
        ...active,
        items: normalizedItems,
        cursor: updatedCursor,
        modeProgress: updatedModeProgress,
        attemptLedger: Array.isArray(active.attemptLedger)
          ? [...active.attemptLedger, ledgerEntry].slice(-150)
          : [ledgerEntry],
        version: Number(active.version || 1) + 1,
      };

      if (completedAfterRetry) {
        updatedActive.status = 'completed';
        updatedActive.completedAt = now;
      }

      const update = {
        $set: {
          'adaptiveQueue.activeQueue': updatedActive,
          'adaptiveProfile.abilityScore': asBoundedNumber(doc?.adaptiveProfile?.abilityScore, 0, 100, 0),
          'adaptiveProfile.targetLevel': String(doc?.adaptiveProfile?.targetLevel || 'A1').toUpperCase(),
          'adaptiveProfile.difficultyBand': {
            min: asBoundedNumber(doc?.adaptiveProfile?.difficultyBand?.min, 1, 5, 1),
            max: asBoundedNumber(doc?.adaptiveProfile?.difficultyBand?.max, 1, 5, 2),
          },
        },
      };

      const updated = await Progress.findOneAndUpdate(filter, update, { new: true }).lean().exec();
      if (!updated) {
        // Possible reasons: version mismatch, idempotencyKey already present, or concurrent update.
        if (idempotencyKey) {
          // Try to fetch existing ledger entry so caller can treat this as a replay
          const fresh = await Progress.findOne({ userId, 'adaptiveQueue.activeQueue.queueId': queueId }).lean().exec();
          const freshActive = fresh?.adaptiveQueue?.activeQueue || null;
          if (freshActive && Array.isArray(freshActive.attemptLedger)) {
            const found = freshActive.attemptLedger.find((e) => e && e.idempotencyKey === idempotencyKey);
            if (found) return res.json({ replay: true, entry: found, activeQueue: freshActive });
          }
        }
        return res.status(409).json({ message: 'Concurrent modification detected, retry' });
      }

      clearByPrefix(progressCache, 'progress:');
      return res.json({ accepted: true, ledgerEntry, activeQueue: updated.adaptiveQueue.activeQueue });
    } catch (err) {
      console.error('Error recording queue attempt:', err);
      return res.status(500).json({ message: 'Failed to record attempt' });
    }
  });

  // POST /api/progress/queue/abandon - abandon active queue
  router.post('/queue/abandon', async (req, res) => {
    try {
      const userId = req.user.id;
      let progress = null;
      if (!isDbConnected()) progress = devStore.getProgressByUser(userId) || createEmptyProgress(userId);
      else progress = await Progress.findOne({ userId }) || createEmptyProgress(userId);

      if (progress && progress.adaptiveQueue && progress.adaptiveQueue.activeQueue) {
        progress.adaptiveQueue.activeQueue.status = 'abandoned';
        progress.adaptiveQueue.activeQueue.abandonedAt = new Date().toISOString();
        progress.adaptiveQueue.activeQueue.version = Number(progress.adaptiveQueue.activeQueue.version || 1) + 1;
      }

      if (progress) {
        await saveProgressForUser({
          userId,
          progress,
          isDbConnected: isDbConnected(),
          Progress,
          devStore,
          clearCache: clearByPrefix,
          progressCache,
          createEmptyProgress,
        });
      }
      return res.json({ message: 'Queue abandoned' });
    } catch (err) {
      console.error('Error abandoning queue:', err);
      return res.status(500).json({ message: 'Failed to abandon queue' });
    }
  });

// GET /api/progress/stats - Get detailed stats
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    const cacheKey = `progress:stats:${userId}`;

    const progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId);
      }
      const doc = await Progress.findOne({ userId });
      return doc ? doc.toObject() : null;
    });

    if (!isDbConnected()) {
      const snapshot = normalizeProgressSnapshot(progress, userId);
      const stats = {
        totalXP: snapshot.totalXP,
        level: buildLevelPayload(snapshot.totalXP),
        streak: snapshot.streak,
        longestStreak: snapshot.longestStreak,
        lessonsCompleted: snapshot.lessonsCompleted,
        wordsLearned: snapshot.wordsLearned,
        avgAccuracy: snapshot.accuracy,
        totalStudyTime: snapshot.totalStudyTime || (snapshot.completedLessons || []).reduce((sum, lesson) => sum + asNonNegativeNumber(lesson.duration, 0), 0),
        lastActivityDate: snapshot.lastActivityDate || new Date(),
        sessionCount: snapshot.completedLessons?.length || 0,
        completedLessons: snapshot.completedLessons || [],
        dailyHistory: snapshot.dailyHistory || [],
      };
      return res.json(stats);
    }

    const snapshot = normalizeProgressSnapshot(progress ? progress : null, userId);
    const stats = {
      totalXP: snapshot.totalXP,
      level: buildLevelPayload(snapshot.totalXP),
      streak: snapshot.streak,
      longestStreak: snapshot.longestStreak,
      lessonsCompleted: snapshot.lessonsCompleted,
      wordsLearned: snapshot.wordsLearned,
      avgAccuracy: snapshot.accuracy,
      totalStudyTime: snapshot.totalStudyTime || (snapshot.completedLessons || []).reduce((sum, lesson) => sum + asNonNegativeNumber(lesson.duration, 0), 0),
      lastActivityDate: snapshot.lastActivityDate || new Date(),
      sessionCount: snapshot.completedLessons?.length || 0,
      completedLessons: snapshot.completedLessons || [],
      dailyHistory: snapshot.dailyHistory || [],
    };
    res.json(stats);
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// GET /api/progress/history?range=7|30|90 - Daily history with period comparison
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const rangeDays = parseRangeDays(req.query.range);

    const cacheKey = `progress:history:${userId}:${rangeDays}`;

    const progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId);
      }
      return Progress.findOne({ userId }).lean();
    });

    const safeRows = normalizeDailyHistoryRows(progress?.dailyHistory || []);

    const series = buildSeries(safeRows, rangeDays);
    const summary = summarizeSeries(series);
    const comparison = buildPeriodComparison(safeRows, rangeDays);

    return res.json({
      rangeDays,
      series,
      summary,
      comparison,
    });
  } catch (err) {
    console.error('Error fetching progress history:', err);
    return res.status(500).json({ message: 'Failed to fetch progress history' });
  }
});

// GET /api/progress/drilldown?days=7|14|30|90 - Exercise-type performance and skill gaps
router.get('/drilldown', async (req, res) => {
  try {
    const userId = req.user.id;
    const windowDays = parseWindowDays(req.query.days);

    const cacheKey = `progress:drilldown:${userId}:${windowDays}`;

    const progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId);
      }
      return Progress.findOne({ userId }).lean();
    });

    const lessons = Array.isArray(progress?.completedLessons) ? progress.completedLessons : [];
    const byType = aggregateByLessonType(lessons, windowDays);
    const skillGaps = deriveSkillGaps(byType);

    return res.json({
      windowDays,
      byType,
      skillGaps,
    });
  } catch (err) {
    console.error('Error fetching progress drilldown:', err);
    return res.status(500).json({ message: 'Failed to fetch progress drilldown' });
  }
});

// GET /api/progress/achievements - Badge and milestone progress
router.get('/achievements', async (req, res) => {
  try {
    const userId = req.user.id;

    const cacheKey = `progress:achievements:${userId}`;

    const progress = await withCache(progressCache, cacheKey, 15000, async () => {
      if (!isDbConnected()) {
        return devStore.getProgressByUser(userId);
      }
      const doc = await Progress.findOne({ userId }).lean();
      return doc || null;
    });

    const snapshot = normalizeProgressSnapshot(progress, userId);
    const achievements = buildAchievementRows(snapshot);
    const unlocked = achievements.filter((a) => a.unlocked);
    const inProgress = achievements.filter((a) => !a.unlocked)
      .sort((a, b) => b.progressPct - a.progressPct);

    return res.json({
      total: achievements.length,
      unlockedCount: unlocked.length,
      completionPct: achievements.length ? Math.round((unlocked.length / achievements.length) * 100) : 0,
      unlocked,
      inProgress,
      all: achievements,
    });
  } catch (err) {
    console.error('Error fetching achievements:', err);
    return res.status(500).json({ message: 'Failed to fetch achievements' });
  }
});

// GET /api/progress/leaderboard?limit=20 - Top learners by XP
router.get('/leaderboard', async (req, res) => {
  try {
    const userId = String(req.user.id);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const scope = parseLeaderboardScope(req.query.scope);
    const windowDays = parseLeaderboardWindowDays(req.query.period, req.query.windowDays);
    const periodLabel = toPeriodLabel(windowDays);

    let users = [];
    let rows = [];
    if (!isDbConnected()) {
      const store = devStore.readStore();
      users = store.users || [];
      const scoped = filterUsersForLeaderboardScope(users, {
        scope,
        requesterId: userId,
        classCode: req.query.classCode,
        creatorCode: req.query.creatorCode,
      });
      rows = buildLeaderboardRows(scoped.users, store.progress || [], { windowDays });

      const top = rows.slice(0, limit);
      const currentUserRank = rows.find((entry) => String(entry.userId) === userId) || null;

      return res.json({
        limit,
        scope,
        period: periodLabel,
        windowDays,
        creatorCodeApplied: scoped.creatorCodeApplied,
        classCodeApplied: scoped.classCodeApplied,
        totalRankedUsers: rows.length,
        leaderboard: top,
        currentUserRank,
      });
    } else {
      users = await User.find({
        isActive: { $ne: false },
        role: { $ne: 'admin' },
        email: { $not: /@(test\.local|test\.com|example\.com)$/i },
      }).select('_id name email role isActive creatorCode linkedCreatorCode classes isSeedAccount').lean();

      const scoped = filterUsersForLeaderboardScope(users, {
        scope,
        requesterId: userId,
        classCode: req.query.classCode,
        creatorCode: req.query.creatorCode,
      });

      const ids = scoped.users.map((u) => String(u._id || u.id));
      const progressRows = ids.length
        ? await Progress.find({ userId: { $in: ids } }).lean()
        : [];

      rows = buildLeaderboardRows(scoped.users, progressRows, { windowDays });

      const top = rows.slice(0, limit);
      const currentUserRank = rows.find((entry) => String(entry.userId) === userId) || null;

      return res.json({
        limit,
        scope,
        period: periodLabel,
        windowDays,
        creatorCodeApplied: scoped.creatorCodeApplied,
        classCodeApplied: scoped.classCodeApplied,
        totalRankedUsers: rows.length,
        leaderboard: top,
        currentUserRank,
      });
    }
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    return res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

router.__internals = {
  classifyAttemptBehavior,
  computeConfidenceScore,
  updateBehaviorSignals,
  buildDailyPlanFromProfile,
  applyMasteryGates,
  applyRemediation,
  finalizeExerciseMix,
  ensureStudyPlanPersonalizationContract,
  normalizeProgressSnapshot,
  updateAdaptiveProfileFromSession,
  normalizeDifficultyBand,
  isMasteredPlanWord,
  buildProgressionUnlockState,
  rankPlanWords,
  selectPlanWordsWithMix,
  summarizeQueueSources,
  buildSubtopicPerfWindow,
  injectRemediationIntoPlan,
};

module.exports = router;
