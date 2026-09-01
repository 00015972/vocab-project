const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'dev-store.json');

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ users: [], words: [], decks: [], progress: [], adminAudit: [], goals: [], alerts: [] }, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      words: Array.isArray(parsed.words) ? parsed.words : [],
      decks: Array.isArray(parsed.decks) ? parsed.decks : [],
      progress: Array.isArray(parsed.progress) ? parsed.progress : [],
      adminAudit: Array.isArray(parsed.adminAudit) ? parsed.adminAudit : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
    };
  } catch {
    const fallback = { users: [], words: [], decks: [], progress: [], adminAudit: [], goals: [], alerts: [] };
    fs.writeFileSync(STORE_FILE, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

function writeStore(store) {
  ensureStoreFile();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function seedDemoData() {
  const store = readStore();
  const hasCreator = store.users.some((user) => user.email === 'creator@test.local' || user.creatorCode === 'DEMO01');
  const hasStudent = store.users.some((user) => user.email === 'student@test.local');
  const hasAdmin = store.users.some((user) => user.email === 'admin@test.local' || (user.role || 'student') === 'admin');
  const hasDemoWords = store.words.some((word) => Array.isArray(word.tags) && word.tags.includes('demo'));

  const creatorCode = 'DEMO01';
  const creator = {
    _id: newId(),
    name: 'Demo Creator',
    email: 'creator@test.local',
    passwordHash: bcrypt.hashSync('Creator123!', 10),
    isVerified: true,
    isActive: true,
    role: 'creator',
    creatorCode,
    isSeedAccount: true,
    createdAt: nowIso(),
  };

  const student = {
    _id: newId(),
    name: 'Demo Student',
    email: 'student@test.local',
    passwordHash: bcrypt.hashSync('Student123!', 10),
    isVerified: true,
    isActive: true,
    role: 'student',
    linkedCreatorCode: creatorCode,
    isSeedAccount: true,
    createdAt: nowIso(),
  };

  const admin = {
    _id: newId(),
    name: 'Demo Admin',
    email: 'admin@test.local',
    passwordHash: bcrypt.hashSync('Admin123!', 10),
    isVerified: true,
    isActive: true,
    role: 'admin',
    isSeedAccount: true,
    createdAt: nowIso(),
  };

  const createdAt = nowIso();
  const words = [
    {
      _id: newId(),
      userId: creator._id,
      word: 'Serendipity',
      definition: 'A lucky discovery made by chance.',
      partOfSpeech: 'noun',
      example: 'Finding that old note was pure serendipity.',
      notes: '',
      tags: ['demo', 'test'],
      difficulty: 3,
      timesReviewed: 2,
      timesCorrect: 2,
      createdAt,
    },
    {
      _id: newId(),
      userId: creator._id,
      word: 'Pragmatic',
      definition: 'Focused on practical results instead of theory.',
      partOfSpeech: 'adjective',
      example: 'She took a pragmatic approach to learning.',
      notes: '',
      tags: ['demo', 'test'],
      difficulty: 2,
      timesReviewed: 1,
      timesCorrect: 1,
      createdAt,
    },
    {
      _id: newId(),
      userId: creator._id,
      word: 'Eloquent',
      definition: 'Expressing ideas clearly and persuasively.',
      partOfSpeech: 'adjective',
      example: 'His eloquent speech won everyone over.',
      notes: '',
      tags: ['demo', 'test'],
      difficulty: 4,
      timesReviewed: 3,
      timesCorrect: 2,
      createdAt,
    },
    {
      _id: newId(),
      userId: creator._id,
      word: 'Resilient',
      definition: 'Able to recover quickly from difficulty.',
      partOfSpeech: 'adjective',
      example: 'The resilient team kept improving after setbacks.',
      notes: '',
      tags: ['demo', 'test'],
      difficulty: 3,
      timesReviewed: 2,
      timesCorrect: 2,
      createdAt,
    },
  ];

  if (!hasCreator) {
    store.users.push(creator);
  }
  if (!hasStudent) {
    store.users.push(student);
  }
  if (!hasAdmin) {
    store.users.push(admin);
  }
  if (!hasDemoWords) {
    store.words.push(...words);
    store.progress.push({
      userId: student._id,
      totalXP: 250,
      streak: 4,
      longestStreak: 6,
      lessonsCompleted: 3,
      wordsLearned: 12,
      accuracy: 87,
      totalStudyTime: 3600,
      completedLessons: [
        { type: 'flashcards', date: nowIso(), xp: 50, accuracy: 90, duration: 1200 },
        { type: 'quiz', date: nowIso(), xp: 80, accuracy: 85, duration: 900 },
        { type: 'matching', date: nowIso(), xp: 120, accuracy: 86, duration: 1500 },
      ],
      dailyHistory: [],
      lastActivityDate: nowIso(),
    });
  }

  writeStore(store);
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

function normalizeProgress(progress = {}) {
  const adaptive = progress.adaptiveProfile && typeof progress.adaptiveProfile === 'object'
    ? progress.adaptiveProfile
    : {};
  const diffBand = adaptive.difficultyBand && typeof adaptive.difficultyBand === 'object'
    ? adaptive.difficultyBand
    : {};
  const diagnostic = adaptive.diagnostic && typeof adaptive.diagnostic === 'object'
    ? adaptive.diagnostic
    : {};

  const adaptiveQueue = progress.adaptiveQueue && typeof progress.adaptiveQueue === 'object' ? progress.adaptiveQueue : {};
  const adaptiveQueueMix = adaptiveQueue.mix && typeof adaptiveQueue.mix === 'object' ? adaptiveQueue.mix : {};
  const activeQueue = adaptiveQueue.activeQueue && typeof adaptiveQueue.activeQueue === 'object' ? adaptiveQueue.activeQueue : {};
  const activeSettings = activeQueue.settings && typeof activeQueue.settings === 'object' ? activeQueue.settings : {};
  const activeCursor = activeQueue.cursor && typeof activeQueue.cursor === 'object' ? activeQueue.cursor : {};

  return {
    userId: progress.userId,
    totalXP: Number(progress.totalXP || 0),
    streak: Number(progress.streak || 0),
    longestStreak: Number(progress.longestStreak || 0),
    lessonsCompleted: Number(progress.lessonsCompleted || 0),
    wordsLearned: Number(progress.wordsLearned || 0),
    accuracy: Number(progress.accuracy || 0),
    totalStudyTime: Number(progress.totalStudyTime || 0),
    adaptiveProfile: {
      targetLevel: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(String(adaptive.targetLevel || '').toUpperCase())
        ? String(adaptive.targetLevel).toUpperCase()
        : 'A1',
      abilityScore: Math.max(0, Math.min(100, Number(adaptive.abilityScore || 0))),
      difficultyBand: {
        min: Math.max(1, Math.min(5, Number(diffBand.min || 1))),
        max: Math.max(1, Math.min(5, Number(diffBand.max || 2))),
      },
      diagnostic: {
        completedAt: diagnostic.completedAt || null,
        attempts: Math.max(0, Number(diagnostic.attempts || 0)),
        correct: Math.max(0, Number(diagnostic.correct || 0)),
        accuracy: Math.max(0, Math.min(100, Number(diagnostic.accuracy || 0))),
        averageLatencyMs: Math.max(0, Number(diagnostic.averageLatencyMs || 0)),
        sessionToken: diagnostic.sessionToken || null,
      },
      behaviorSignals: {
        baselineLatencyMs: Math.max(0, Number(adaptive.behaviorSignals?.baselineLatencyMs || 2200)),
        confidenceScore: Math.max(0, Math.min(1, Number(adaptive.behaviorSignals?.confidenceScore || 0.6))),
        fastGuessRate: Math.max(0, Math.min(1, Number(adaptive.behaviorSignals?.fastGuessRate || 0))),
        slowStruggleRate: Math.max(0, Math.min(1, Number(adaptive.behaviorSignals?.slowStruggleRate || 0))),
        recentBehaviors: Array.isArray(adaptive.behaviorSignals?.recentBehaviors) ? adaptive.behaviorSignals.recentBehaviors.slice(-12).map((value) => String(value)) : [],
        updatedAt: adaptive.behaviorSignals?.updatedAt || null,
      },
      masteryGates: {
        flashcards: {
          unlocked: adaptive.masteryGates?.flashcards?.unlocked !== false,
          reason: String(adaptive.masteryGates?.flashcards?.reason || 'Available by default.'),
          requiredSubSkills: Array.isArray(adaptive.masteryGates?.flashcards?.requiredSubSkills) ? adaptive.masteryGates.flashcards.requiredSubSkills.filter((value) => typeof value === 'string').map((value) => String(value)) : [],
          subSkills: adaptive.masteryGates?.flashcards?.subSkills && typeof adaptive.masteryGates.flashcards.subSkills === 'object'
            ? Object.fromEntries(Object.entries(adaptive.masteryGates.flashcards.subSkills).map(([key, value]) => [key, { label: String(value?.label || key), passed: !!value?.passed, score: Number(value?.score || 0), threshold: Number(value?.threshold || 0), reason: String(value?.reason || '') }]))
            : {},
          lastUnlockedAt: adaptive.masteryGates?.flashcards?.lastUnlockedAt || null,
          lastLockedAt: adaptive.masteryGates?.flashcards?.lastLockedAt || null,
          transitionCount: Math.max(0, Number(adaptive.masteryGates?.flashcards?.transitionCount || 0)),
          transitionHistory: Array.isArray(adaptive.masteryGates?.flashcards?.transitionHistory) ? adaptive.masteryGates.flashcards.transitionHistory.filter((value) => value && typeof value === 'object').map((value) => ({ ...value })) : [],
        },
        matching: {
          unlocked: adaptive.masteryGates?.matching?.unlocked === true,
          reason: String(adaptive.masteryGates?.matching?.reason || 'Improve confidence or accuracy to unlock.'),
          requiredSubSkills: Array.isArray(adaptive.masteryGates?.matching?.requiredSubSkills) ? adaptive.masteryGates.matching.requiredSubSkills.filter((value) => typeof value === 'string').map((value) => String(value)) : [],
          subSkills: adaptive.masteryGates?.matching?.subSkills && typeof adaptive.masteryGates.matching.subSkills === 'object'
            ? Object.fromEntries(Object.entries(adaptive.masteryGates.matching.subSkills).map(([key, value]) => [key, { label: String(value?.label || key), passed: !!value?.passed, score: Number(value?.score || 0), threshold: Number(value?.threshold || 0), reason: String(value?.reason || '') }]))
            : {},
          lastUnlockedAt: adaptive.masteryGates?.matching?.lastUnlockedAt || null,
          lastLockedAt: adaptive.masteryGates?.matching?.lastLockedAt || null,
          transitionCount: Math.max(0, Number(adaptive.masteryGates?.matching?.transitionCount || 0)),
          transitionHistory: Array.isArray(adaptive.masteryGates?.matching?.transitionHistory) ? adaptive.masteryGates.matching.transitionHistory.filter((value) => value && typeof value === 'object').map((value) => ({ ...value })) : [],
        },
        quiz: {
          unlocked: adaptive.masteryGates?.quiz?.unlocked === true,
          reason: String(adaptive.masteryGates?.quiz?.reason || 'Improve confidence or accuracy to unlock.'),
          requiredSubSkills: Array.isArray(adaptive.masteryGates?.quiz?.requiredSubSkills) ? adaptive.masteryGates.quiz.requiredSubSkills.filter((value) => typeof value === 'string').map((value) => String(value)) : [],
          subSkills: adaptive.masteryGates?.quiz?.subSkills && typeof adaptive.masteryGates.quiz.subSkills === 'object'
            ? Object.fromEntries(Object.entries(adaptive.masteryGates.quiz.subSkills).map(([key, value]) => [key, { label: String(value?.label || key), passed: !!value?.passed, score: Number(value?.score || 0), threshold: Number(value?.threshold || 0), reason: String(value?.reason || '') }]))
            : {},
          lastUnlockedAt: adaptive.masteryGates?.quiz?.lastUnlockedAt || null,
          lastLockedAt: adaptive.masteryGates?.quiz?.lastLockedAt || null,
          transitionCount: Math.max(0, Number(adaptive.masteryGates?.quiz?.transitionCount || 0)),
          transitionHistory: Array.isArray(adaptive.masteryGates?.quiz?.transitionHistory) ? adaptive.masteryGates.quiz.transitionHistory.filter((value) => value && typeof value === 'object').map((value) => ({ ...value })) : [],
        },
        spelling: {
          unlocked: adaptive.masteryGates?.spelling?.unlocked === true,
          reason: String(adaptive.masteryGates?.spelling?.reason || 'Improve confidence or accuracy to unlock.'),
          requiredSubSkills: Array.isArray(adaptive.masteryGates?.spelling?.requiredSubSkills) ? adaptive.masteryGates.spelling.requiredSubSkills.filter((value) => typeof value === 'string').map((value) => String(value)) : [],
          subSkills: adaptive.masteryGates?.spelling?.subSkills && typeof adaptive.masteryGates.spelling.subSkills === 'object'
            ? Object.fromEntries(Object.entries(adaptive.masteryGates.spelling.subSkills).map(([key, value]) => [key, { label: String(value?.label || key), passed: !!value?.passed, score: Number(value?.score || 0), threshold: Number(value?.threshold || 0), reason: String(value?.reason || '') }]))
            : {},
          lastUnlockedAt: adaptive.masteryGates?.spelling?.lastUnlockedAt || null,
          lastLockedAt: adaptive.masteryGates?.spelling?.lastLockedAt || null,
          transitionCount: Math.max(0, Number(adaptive.masteryGates?.spelling?.transitionCount || 0)),
          transitionHistory: Array.isArray(adaptive.masteryGates?.spelling?.transitionHistory) ? adaptive.masteryGates.spelling.transitionHistory.filter((value) => value && typeof value === 'object').map((value) => ({ ...value })) : [],
        },
      },
      remediation: {
        active: !!adaptive.remediation?.active,
        reason: String(adaptive.remediation?.reason || ''),
        focusModes: Array.isArray(adaptive.remediation?.focusModes) ? adaptive.remediation.focusModes.map((item) => String(item)) : [],
        recommendedWordIds: Array.isArray(adaptive.remediation?.recommendedWordIds) ? adaptive.remediation.recommendedWordIds.map((item) => String(item)) : [],
        updatedAt: adaptive.remediation?.updatedAt || null,
      },
    },
    completedLessons: Array.isArray(progress.completedLessons) ? progress.completedLessons : [],
    dailyHistory: Array.isArray(progress.dailyHistory) ? progress.dailyHistory : [],
    adaptiveQueue: {
      generatedAt: adaptiveQueue.generatedAt || null,
      targetWords: Number(adaptiveQueue.targetWords || 0),
      dueReviewCount: Number(adaptiveQueue.dueReviewCount || 0),
      remediationCount: Number(adaptiveQueue.remediationCount || 0),
      mix: {
        totalRequested: Math.max(0, Number(adaptiveQueueMix.totalRequested || 0)),
        targetCounts: {
          current: Math.max(0, Number(adaptiveQueueMix?.targetCounts?.current || 0)),
          stretch: Math.max(0, Number(adaptiveQueueMix?.targetCounts?.stretch || 0)),
          review: Math.max(0, Number(adaptiveQueueMix?.targetCounts?.review || 0)),
        },
        counts: {
          current: Math.max(0, Number(adaptiveQueueMix?.counts?.current || 0)),
          stretch: Math.max(0, Number(adaptiveQueueMix?.counts?.stretch || 0)),
          review: Math.max(0, Number(adaptiveQueueMix?.counts?.review || 0)),
        },
        ratios: {
          current: Math.max(0, Math.min(1, Number(adaptiveQueueMix?.ratios?.current || 0.7))),
          stretch: Math.max(0, Math.min(1, Number(adaptiveQueueMix?.ratios?.stretch || 0.2))),
          review: Math.max(0, Math.min(1, Number(adaptiveQueueMix?.ratios?.review || 0.1))),
        },
      },
      queuePreview: Array.isArray(adaptiveQueue.queuePreview)
        ? adaptiveQueue.queuePreview.map((item) => ({
          wordId: String(item?.wordId || ''),
          word: String(item?.word || ''),
          difficulty: Math.max(1, Math.min(5, Number(item?.difficulty || 3))),
          source: String(item?.source || 'general'),
          position: Math.max(0, Number(item?.position || 0)),
        }))
        : [],
      activeQueue: {
        planId: activeQueue.planId || null,
        queueId: activeQueue.queueId || null,
        status: activeQueue.status || null,
        version: Math.max(1, Number(activeQueue.version || 1)),
        createdAt: activeQueue.createdAt || null,
        expiresAt: activeQueue.expiresAt || null,
        completedAt: activeQueue.completedAt || null,
        abandonedAt: activeQueue.abandonedAt || null,
        settings: {
          minutes: Math.max(10, Number(activeSettings.minutes || 20)),
          wordCount: Math.max(5, Number(activeSettings.wordCount || 16)),
          targetLevel: String(activeSettings.targetLevel || 'AUTO').toUpperCase(),
          hearts: Math.max(0, Math.min(5, Number(activeSettings.hearts || 5))),
          difficultyBand: activeSettings.difficultyBand || {},
        },
        cursor: {
          nextIndex: Math.max(0, Number(activeCursor.nextIndex || 0)),
          completedCount: Math.max(0, Number(activeCursor.completedCount || 0)),
        },
        modeProgress: activeQueue.modeProgress || {},
        items: Array.isArray(activeQueue.items) ? activeQueue.items : [],
        attemptLedger: Array.isArray(activeQueue.attemptLedger) ? activeQueue.attemptLedger.slice(-150).map((entry) => ({
          idempotencyKey: entry?.idempotencyKey || '',
          queueItemId: entry?.queueItemId || '',
          mode: entry?.mode || '',
          accepted: !!entry?.accepted,
          advancedToIndex: Number(entry?.advancedToIndex || 0),
          version: Number(entry?.version || 1),
          response: entry?.response || null,
          createdAt: entry?.createdAt || null,
        })) : [],
      },
    },
    lastActivityDate: progress.lastActivityDate || nowIso(),
  };
}

function findUserByEmail(email) {
  const { users } = readStore();
  return users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
}

function findCreatorByCode(creatorCode) {
  const code = String(creatorCode || '').toUpperCase().trim();
  if (!code) return null;
  const { users } = readStore();
  return users.find((u) => (u.role || 'creator') === 'creator' && String(u.creatorCode || '').toUpperCase() === code);
}

function findUserById(id) {
  const { users } = readStore();
  return users.find((u) => u._id === id);
}

function listUsers() {
  const { users } = readStore();
  return users;
}

function createUser({ name, email, passwordHash, isVerified = true, isActive = true, role = 'student', creatorCode = '', linkedCreatorCode = '' }) {
  const store = readStore();
  const user = {
    _id: newId(),
    name,
    email: String(email).toLowerCase(),
    passwordHash,
    isVerified,
    isActive,
    role,
    creatorCode: creatorCode ? String(creatorCode).toUpperCase().trim() : undefined,
    linkedCreatorCode: linkedCreatorCode ? String(linkedCreatorCode).toUpperCase().trim() : undefined,
    createdAt: nowIso(),
  };
  store.users.push(user);
  writeStore(store);
  return user;
}

function updateUser(id, updates) {
  const store = readStore();
  const user = store.users.find((u) => u._id === id);
  if (!user) return null;
  Object.assign(user, updates);
  writeStore(store);
  return user;
}

function deleteUser(id) {
  const store = readStore();
  const idx = store.users.findIndex((u) => u._id === id);
  if (idx >= 0) store.users.splice(idx, 1);
  for (let i = store.words.length - 1; i >= 0; i -= 1) {
    if (store.words[i].userId === id) store.words.splice(i, 1);
  }
  writeStore(store);
}

function getWordsByUser(userId) {
  const { words } = readStore();
  return words
    .filter((w) => w.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getWordsByUserIds(userIds) {
  const set = new Set((userIds || []).map((id) => String(id)));
  const { words } = readStore();
  return words
    .filter((w) => set.has(String(w.userId)))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function createWord(userId, payload) {
  const store = readStore();
  const entry = {
    _id: newId(),
    userId,
    word: payload.word,
    definition: payload.definition,
    imageUrl: payload.imageUrl || '',
    partOfSpeech: payload.partOfSpeech || 'other',
    example: payload.example || '',
    notes: payload.notes || '',
    tags: payload.tags || [],
    deckId: payload.deckId || null,
    difficulty: payload.difficulty || 3,
    domain: payload.domain || 'general',
    targetScoreRange: payload.targetScoreRange || '500-600',
    learningStatus: payload.learningStatus || 'locked',
    adaptiveMetrics: payload.adaptiveMetrics || {
      attempts: 0,
      correct: 0,
      incorrect: 0,
      consecutiveCorrectAcrossSessions: 0,
      averageLatencyMs: 0,
      lastLatencyMs: 0,
      abilityDelta: 0,
      dueAt: null,
      masteredAt: null,
      masteryStatus: 'locked',
      masteryUpdatedAt: null,
      masteryRecentAccuracy: 0,
      masterySessionCount: 0,
      masteryQualifyingSessions: 0,
      masteryDistinctDays: 0,
      masterySpreadDays: 0,
      masteryHistory: [],
      lastAttemptAt: null,
    },
    timesReviewed: 0,
    timesCorrect: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    createdAt: nowIso(),
  };
  store.words.push(entry);
  writeStore(store);
  return entry;
}

function decorateDeck(deck, store) {
  const words = (store.words || []).filter((word) => String(word.deckId || '') === String(deck._id));
  return {
    ...deck,
    wordCount: words.length,
  };
}

function listDecksByCreator(creatorId) {
  const store = readStore();
  return (store.decks || [])
    .filter((deck) => deck.creatorId === creatorId)
    .map((deck) => decorateDeck(deck, store))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function listPublicDecks({ search = '', tag = '' } = {}) {
  const store = readStore();
  const query = String(search || '').toLowerCase();
  const tagValue = String(tag || '').toLowerCase();
  return (store.decks || [])
    .filter((deck) => deck.isPublic)
    .filter((deck) => !query || String(deck.name || '').toLowerCase().includes(query))
    .filter((deck) => !tagValue || (Array.isArray(deck.tags) && deck.tags.some((item) => String(item).toLowerCase() === tagValue)))
    .map((deck) => decorateDeck(deck, store))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function findDeckById(id) {
  const store = readStore();
  const deck = (store.decks || []).find((entry) => entry._id === id);
  return deck ? decorateDeck(deck, store) : null;
}

function createDeck(creatorId, payload) {
  const store = readStore();
  const entry = {
    _id: newId(),
    creatorId,
    name: payload.name,
    description: payload.description || '',
    isPublic: Boolean(payload.isPublic),
    isFeatured: Boolean(payload.isFeatured),
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    difficulty: payload.difficulty || 'intermediate',
    language: payload.language || 'English',
    topic: payload.topic || '',
    coverImage: payload.coverImage || '',
    downloads: Number(payload.downloads || 0),
    forks: Array.isArray(payload.forks) ? payload.forks : [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.decks = Array.isArray(store.decks) ? store.decks : [];
  store.decks.push(entry);
  writeStore(store);
  return decorateDeck(entry, store);
}

function updateDeck(id, creatorId, payload) {
  const store = readStore();
  store.decks = Array.isArray(store.decks) ? store.decks : [];
  const deck = store.decks.find((entry) => entry._id === id && entry.creatorId === creatorId);
  if (!deck) return null;
  Object.assign(deck, payload, { updatedAt: nowIso() });
  writeStore(store);
  return decorateDeck(deck, store);
}

function deleteDeck(id, creatorId) {
  const store = readStore();
  store.decks = Array.isArray(store.decks) ? store.decks : [];
  const idx = store.decks.findIndex((entry) => entry._id === id && entry.creatorId === creatorId);
  if (idx < 0) return false;
  store.decks.splice(idx, 1);
  store.words = (store.words || []).map((word) => String(word.deckId || '') === String(id) ? { ...word, deckId: null } : word);
  writeStore(store);
  return true;
}

function findWordByIdForUser(id, userId) {
  const { words } = readStore();
  return words.find((w) => w._id === id && w.userId === userId);
}

function findWordById(id) {
  const { words } = readStore();
  return words.find((w) => w._id === id);
}

function updateWord(id, userId, payload) {
  const store = readStore();
  const word = store.words.find((w) => w._id === id && w.userId === userId);
  if (!word) return null;
  Object.assign(word, payload);
  writeStore(store);
  return word;
}

function updateWordGlobal(id, payload) {
  const store = readStore();
  const word = store.words.find((w) => w._id === id);
  if (!word) return null;
  Object.assign(word, payload);
  writeStore(store);
  return word;
}

function deleteWord(id, userId) {
  const store = readStore();
  const idx = store.words.findIndex((w) => w._id === id && w.userId === userId);
  if (idx < 0) return false;
  store.words.splice(idx, 1);
  writeStore(store);
  return true;
}

function deleteWordGlobal(id) {
  const store = readStore();
  const idx = store.words.findIndex((w) => w._id === id);
  if (idx < 0) return false;
  store.words.splice(idx, 1);
  writeStore(store);
  return true;
}

function getProgressByUser(userId) {
  const store = readStore();
  const entry = store.progress.find((p) => p.userId === userId);
  return entry ? normalizeProgress(entry) : null;
}

function saveProgress(userId, progress) {
  const store = readStore();
  const idx = store.progress.findIndex((p) => p.userId === userId);
  const normalized = normalizeProgress({ ...progress, userId });
  if (idx >= 0) {
    store.progress[idx] = normalizeProgress({ ...store.progress[idx], ...normalized, userId });
  } else {
    store.progress.push(normalized);
  }
  writeStore(store);
  return normalizeProgress(store.progress[idx >= 0 ? idx : store.progress.length - 1]);
}

function addAdminAudit(entry) {
  const store = readStore();
  const event = {
    id: newId(),
    adminId: entry.adminId || '',
    adminEmail: String(entry.adminEmail || '').toLowerCase(),
    action: entry.action || 'unknown',
    targetUserId: entry.targetUserId || null,
    targetEmail: entry.targetEmail || null,
    details: entry.details || {},
    createdAt: entry.createdAt || nowIso(),
  };
  store.adminAudit.unshift(event);
  if (store.adminAudit.length > 5000) {
    store.adminAudit = store.adminAudit.slice(0, 5000);
  }
  writeStore(store);
  return event;
}

function listAdminAudit() {
  const store = readStore();
  return store.adminAudit
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ─── Goals ────────────────────────────────────────────────────────────────────

const VALID_METRICS = ['accuracy', 'avgXP', 'sessions', 'streak', 'activeRate', 'wordsLearned'];
const VALID_TIMEFRAMES = ['weekly', 'monthly', 'allTime'];

function normalizeGoal(goal = {}) {
  return {
    _id: goal._id || newId(),
    creatorCode: String(goal.creatorCode || '').toUpperCase().trim(),
    label: String(goal.label || '').trim(),
    metric: VALID_METRICS.includes(goal.metric) ? goal.metric : 'accuracy',
    target: Number(goal.target) || 0,
    timeframe: VALID_TIMEFRAMES.includes(goal.timeframe) ? goal.timeframe : 'monthly',
    createdAt: goal.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeAlert(alert = {}) {
  return {
    _id: alert._id || newId(),
    creatorCode: String(alert.creatorCode || '').toUpperCase().trim(),
    goalId: String(alert.goalId || ''),
    status: String(alert.status || 'behind'),
    severity: String(alert.severity || 'warning'),
    message: String(alert.message || ''),
    createdAt: alert.createdAt || nowIso(),
    updatedAt: nowIso(),
    dismissed: Boolean(alert.dismissed),
    reviewed: Boolean(alert.reviewed),
  };
}

function getGoalsByCreator(creatorCode) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const { goals } = readStore();
  return goals.filter((g) => String(g.creatorCode || '').toUpperCase() === code);
}

function getAlertsByCreator(creatorCode) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const { alerts = [] } = readStore();
  return alerts
    .filter((alert) => String(alert.creatorCode || '').toUpperCase() === code)
    .map((alert) => normalizeAlert(alert));
}

function createAlert(creatorCode, payload) {
  const store = readStore();
  const alert = normalizeAlert({ ...payload, creatorCode });
  store.alerts = Array.isArray(store.alerts) ? store.alerts : [];
  store.alerts.push(alert);
  writeStore(store);
  return alert;
}

function updateAlert(id, creatorCode, payload) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const store = readStore();
  store.alerts = Array.isArray(store.alerts) ? store.alerts : [];
  const idx = store.alerts.findIndex(
    (alert) => String(alert._id) === String(id) && String(alert.creatorCode || '').toUpperCase() === code
  );
  if (idx < 0) return null;
  store.alerts[idx] = normalizeAlert({ ...store.alerts[idx], ...payload, _id: id, creatorCode });
  writeStore(store);
  return store.alerts[idx];
}

function deleteAlert(id, creatorCode) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const store = readStore();
  store.alerts = Array.isArray(store.alerts) ? store.alerts : [];
  const idx = store.alerts.findIndex(
    (alert) => String(alert._id) === String(id) && String(alert.creatorCode || '').toUpperCase() === code
  );
  if (idx < 0) return false;
  store.alerts.splice(idx, 1);
  writeStore(store);
  return true;
}

function createGoal(creatorCode, payload) {
  const store = readStore();
  const goal = normalizeGoal({ ...payload, creatorCode });
  store.goals.push(goal);
  writeStore(store);
  return goal;
}

function updateGoal(id, creatorCode, payload) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const store = readStore();
  const idx = store.goals.findIndex(
    (g) => g._id === id && String(g.creatorCode || '').toUpperCase() === code
  );
  if (idx < 0) return null;
  store.goals[idx] = normalizeGoal({ ...store.goals[idx], ...payload, _id: id, creatorCode });
  writeStore(store);
  return store.goals[idx];
}

function deleteGoal(id, creatorCode) {
  const code = String(creatorCode || '').toUpperCase().trim();
  const store = readStore();
  const idx = store.goals.findIndex(
    (g) => g._id === id && String(g.creatorCode || '').toUpperCase() === code
  );
  if (idx < 0) return false;
  store.goals.splice(idx, 1);
  writeStore(store);
  return true;
}

module.exports = {
  readStore,
  findUserByEmail,
  findCreatorByCode,
  findUserById,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getWordsByUser,
  getWordsByUserIds,
  listDecksByCreator,
  listPublicDecks,
  findDeckById,
  createDeck,
  updateDeck,
  deleteDeck,
  createWord,
  findWordByIdForUser,
  findWordById,
  updateWord,
  updateWordGlobal,
  deleteWord,
  deleteWordGlobal,
  getProgressByUser,
  saveProgress,
  addAdminAudit,
  listAdminAudit,
  getGoalsByCreator,
  getAlertsByCreator,
  createAlert,
  updateAlert,
  deleteAlert,
  createGoal,
  updateGoal,
  deleteGoal,
  seedDemoData,
};

seedDemoData();
