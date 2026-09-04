const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const auth = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');
const User = require('../models/User');
const Word = require('../models/Word');
const Progress = require('../models/Progress');
const PEXELS_API_KEY = String(process.env.PEXELS_API_KEY || '').trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim();
const GEMINI_API_MODE = String(process.env.GEMINI_API_MODE || 'auto').trim().toLowerCase();
const GEMINI_MAX_RETRIES = Math.max(1, Math.min(4, parseInt(process.env.GEMINI_MAX_RETRIES || '3', 10) || 3));
const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';

const GENERATED_DIR = path.join(__dirname, '..', '..', 'public', 'generated');
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, GENERATED_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file && file.originalname || '')).toLowerCase() || '.jpg';
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const uploadImage = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (String(file && file.mimetype || '').startsWith('image/')) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed.'));
  },
});

router.use(auth);

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getGroq() {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

function extractJsonArrayText(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/\[[\s\S]*\]/);
  return match ? match[0] : '';
}

function buildFallbackDefinition(word) {
  const cleanWord = safeText(word);
  return cleanWord
    ? `The word "${cleanWord}" is used in everyday English to express a specific idea, action, or feeling.`
    : 'This English word is used to express a specific idea, action, or feeling in context.';
}

function buildFallbackExample(word, definition) {
  const cleanWord = safeText(word);
  const cleanDefinition = safeText(definition);
  if (!cleanWord) return 'This word appears in everyday English and is useful for learners to study.';
  if (cleanDefinition) return `In class, students used the word "${cleanWord}" when discussing ${cleanDefinition.toLowerCase()}.`;
  return `Students practiced the word "${cleanWord}" in a sentence so its meaning became clearer.`;
}

function normalizeGeneratedWordList(words) {
  if (!Array.isArray(words)) return [];
  return words
    .filter((w) => w && typeof w.word === 'string' && w.word.trim())
    .map((w) => {
      const word = String(w.word || '').trim().slice(0, 100);
      const definition = safeText(w.definition || '') || buildFallbackDefinition(word);
      const example = safeText(w.example || '') || buildFallbackExample(word, definition);
      const partOfSpeech = ['noun', 'verb', 'adjective', 'adverb', 'phrase', 'idiom', 'other'].includes(String(w.partOfSpeech || '').toLowerCase())
        ? String(w.partOfSpeech).toLowerCase()
        : 'other';

      return {
        word,
        definition: definition.slice(0, 600),
        example: example.slice(0, 400),
        partOfSpeech,
      };
    })
    .slice(0, 40);
}

function summarizeProviderError(provider, err) {
  const status = (err && err.statusCode) || (err && err.response && err.response.status) || 'unknown';
  const message = (err && err.message) ? String(err.message) : 'request failed';
  return `${provider}:${status}:${message}`;
}

function hashText(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function buildRuleBasedWordList(topic, numWords, level) {
  const safeTopic = safeText(topic || 'everyday learning');
  const bank = [
    { word: 'analyze', definition: 'To examine information carefully and in detail to understand patterns and meaning.', example: `Students analyze key ideas in ${safeTopic} to improve understanding.`, partOfSpeech: 'verb' },
    { word: 'context', definition: 'The surrounding situation that helps explain the meaning of a word or event.', example: `Learning new terms in context makes ${safeTopic} vocabulary easier to remember.`, partOfSpeech: 'noun' },
    { word: 'interpret', definition: 'To explain or understand the meaning of information, language, or behavior.', example: `Learners interpret difficult passages about ${safeTopic} more accurately over time.`, partOfSpeech: 'verb' },
    { word: 'coherent', definition: 'Clear, logical, and easy to follow in speech or writing.', example: `A coherent explanation helped the class discuss ${safeTopic} effectively.`, partOfSpeech: 'adjective' },
    { word: 'nuance', definition: 'A subtle difference in meaning, expression, or tone.', example: `Advanced learners notice nuance when reading complex ${safeTopic} material.`, partOfSpeech: 'noun' },
    { word: 'articulate', definition: 'To express ideas clearly and effectively in speech or writing.', example: `She could articulate her opinion about ${safeTopic} with confidence.`, partOfSpeech: 'verb' },
    { word: 'comprehensive', definition: 'Complete and including all important details.', example: `They created a comprehensive glossary for ${safeTopic}.`, partOfSpeech: 'adjective' },
    { word: 'synthesize', definition: 'To combine ideas from different sources into one clear understanding.', example: `The final task asked students to synthesize several texts on ${safeTopic}.`, partOfSpeech: 'verb' },
    { word: 'inference', definition: 'A conclusion reached from evidence and reasoning rather than direct statements.', example: `Readers made an inference about the author\'s view of ${safeTopic}.`, partOfSpeech: 'noun' },
    { word: 'accurate', definition: 'Correct and free from mistakes.', example: `Accurate vocabulary use improved their presentation on ${safeTopic}.`, partOfSpeech: 'adjective' },
    { word: 'perspective', definition: 'A particular way of thinking about or understanding something.', example: `The article offered a new perspective on ${safeTopic}.`, partOfSpeech: 'noun' },
    { word: 'evaluate', definition: 'To judge the quality, value, or effectiveness of something.', example: `Students evaluate sources before writing about ${safeTopic}.`, partOfSpeech: 'verb' },
  ];

  const difficultyOrder = {
    beginner: [0, 1, 9, 10, 5, 11],
    intermediate: [0, 2, 3, 6, 8, 11, 10, 5],
    advanced: [2, 3, 4, 6, 7, 8, 10, 11, 5],
    expert: [4, 7, 8, 2, 6, 3, 10, 11, 5],
  };
  const indices = difficultyOrder[level] || difficultyOrder.intermediate;
  const ordered = indices.map((idx) => bank[idx]).filter(Boolean);

  const seeded = [];
  const start = hashText(safeTopic) % ordered.length;
  for (let i = 0; i < ordered.length; i += 1) {
    seeded.push(ordered[(start + i) % ordered.length]);
  }

  return seeded.slice(0, Math.max(1, Math.min(40, Number(numWords) || 10)));
}

async function generateWordListWithFallback(prompt, options = {}) {
  const providerErrors = [];

  try {
    const geminiPayload = await callGeminiForJson(prompt);
    const words = extractWordArrayFromPayload(geminiPayload);
    if (!words.length) throw new Error('Gemini did not return a JSON array.');
    console.info('generateWordListWithFallback provider=gemini words=' + (Array.isArray(words) ? words.length : 0));
    return { words, provider: 'gemini', model: GEMINI_MODEL };
  } catch (err) {
    providerErrors.push(summarizeProviderError('gemini', err));
  }

  try {
    const groqModel = String(process.env.GROQ_MODEL || 'canopylabs/orpheus-v1-english').trim();
    const groq = getGroq();
    const completion = await groq.chat.completions.create({
      model: groqModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.6,
    });
    const raw = completion && completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : '';
    const jsonText = extractJsonArrayText(raw);
    if (!jsonText) throw new Error('Groq returned unexpected format.');
    console.info('generateWordListWithFallback provider=groq model=' + groqModel + ' words=unknown');
    return { words: JSON.parse(jsonText), provider: 'groq', model: groqModel };
  } catch (err) {
    providerErrors.push(summarizeProviderError('groq', err));
  }

  try {
    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.6,
    });
    const raw = completion && completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : '';
    const jsonText = extractJsonArrayText(raw);
    if (!jsonText) throw new Error('OpenAI returned unexpected format.');
    console.info('generateWordListWithFallback provider=openai model=gpt-4o-mini words=unknown');
    return { words: JSON.parse(jsonText), provider: 'openai', model: 'gpt-4o-mini' };
  } catch (err) {
    providerErrors.push(summarizeProviderError('openai', err));
  }

  return {
    words: buildRuleBasedWordList(options.topic, options.numWords, options.level),
    provider: 'rule-engine',
    providerErrors,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPollinationsImageWithRetry(fullPrompt, attempts = 3) {
  let lastErr = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const polUrl = buildPollinationsUrl(fullPrompt, i);
      const polResponse = await axios.get(polUrl, { responseType: 'arraybuffer', timeout: 15000 });

      const contentType = String(polResponse.headers && polResponse.headers['content-type'] || '').toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        const err = new Error('Pollinations returned a non-image response.');
        err.code = 'NON_IMAGE_RESPONSE';
        throw err;
      }

      return polResponse.data;
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      const canRetry = status === 429 || status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT';
      if (!canRetry || i === attempts - 1) break;
      await sleep(700 * (i + 1));
    }
  }

  throw lastErr || new Error('Pollinations request failed.');
}

function buildPollinationsUrl(fullPrompt, seedOffset = 0) {
  const seed = Math.abs((Date.now() + seedOffset + fullPrompt.length) % 1000000007);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=512&height=512&seed=${seed}&nologo=true&model=flux`;
}

function safeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeEnglishGrade(rawGrade) {
  const cleaned = String(rawGrade || '').trim().toUpperCase();
  const allowed = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'AUTO']);
  if (allowed.has(cleaned)) return cleaned;
  return 'AUTO';
}

function inferGradeFromSignals(progressSnapshot = {}) {
  const accuracy = clampNumber(progressSnapshot.accuracy, 0, 100, 0);
  const xp = clampNumber(progressSnapshot.totalXP, 0, 1000000, 0);
  const streak = clampNumber(progressSnapshot.streak, 0, 3650, 0);
  const lessons = clampNumber(progressSnapshot.lessonsCompleted, 0, 1000000, 0);

  if (accuracy < 55 || lessons < 3) return 'A1';
  if (accuracy < 65 || xp < 400) return 'A2';
  if (accuracy < 78 || xp < 1500) return 'B1';
  if (accuracy < 88 || xp < 4500) return 'B2';
  if (accuracy < 95 || streak < 21) return 'C1';
  return 'C2';
}

function difficultyBandForGrade(grade) {
  const map = {
    A1: { min: 1, max: 2 },
    A2: { min: 2, max: 3 },
    B1: { min: 3, max: 4 },
    B2: { min: 3, max: 5 },
    C1: { min: 4, max: 5 },
    C2: { min: 5, max: 5 },
  };
  return map[grade] || { min: 2, max: 3 };
}

function gradeWordMultiplier(grade) {
  const map = {
    A1: 0.85,
    A2: 0.95,
    B1: 1,
    B2: 1.15,
    C1: 1.3,
    C2: 1.45,
  };
  return map[grade] || 1;
}

function normalizeLearningStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'active';
  if (['new', 'active', 'review', 'mastered', 'struggling'].includes(normalized)) return normalized;
  return 'active';
}

function normalizeTargetScoreRange(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'balanced';
  if (['foundation', 'balanced', 'stretch', 'exam'].includes(normalized)) return normalized;
  return 'balanced';
}

function daysSinceIso(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - at.getTime()) / 86400000));
}

function buildFilteringSummary(words, band, resolvedGrade) {
  const summary = {
    totalPool: Array.isArray(words) ? words.length : 0,
    inBand: 0,
    struggling: 0,
    newWords: 0,
    reviewQueue: 0,
    masteredSkipped: 0,
    targetRanges: {},
    grade: resolvedGrade,
    difficultyBand: band,
  };

  (Array.isArray(words) ? words : []).forEach((word) => {
    const difficulty = clampNumber(word?.difficulty, 1, 5, 3);
    const status = normalizeLearningStatus(word?.learningStatus);
    const range = normalizeTargetScoreRange(word?.targetScoreRange);
    summary.targetRanges[range] = (summary.targetRanges[range] || 0) + 1;
    if (difficulty >= band.min && difficulty <= band.max) summary.inBand += 1;
    if (status === 'struggling') summary.struggling += 1;
    if (status === 'new') summary.newWords += 1;
    if (status === 'review') summary.reviewQueue += 1;
    if (status === 'mastered') summary.masteredSkipped += 1;
  });

  return summary;
}

function scoreWordForWeeklyPlan(word, band, resolvedGrade) {
  const difficulty = clampNumber(word?.difficulty, 1, 5, 3);
  const status = normalizeLearningStatus(word?.learningStatus);
  const range = normalizeTargetScoreRange(word?.targetScoreRange);
  const reviewed = clampNumber(word?.timesReviewed, 0, 10000, 0);
  const correct = clampNumber(word?.timesCorrect, 0, 10000, 0);
  const accuracy = reviewed ? (correct / reviewed) : 0;
  const staleDays = daysSinceIso(word?.lastReviewedAt);
  const inBand = difficulty >= band.min && difficulty <= band.max;

  let score = inBand ? 2.2 : -1.5;
  score += reviewed === 0 ? 1.6 : 0;
  score += status === 'struggling' ? 2.6 : 0;
  score += status === 'review' ? 1.8 : 0;
  score += status === 'new' ? 1.2 : 0;
  score += status === 'mastered' ? -2.1 : 0;
  score += range === 'foundation' && ['A1', 'A2'].includes(resolvedGrade) ? 0.9 : 0;
  score += range === 'stretch' && ['B2', 'C1', 'C2'].includes(resolvedGrade) ? 0.85 : 0;
  score += range === 'exam' && ['B1', 'B2', 'C1', 'C2'].includes(resolvedGrade) ? 0.75 : 0;
  score += reviewed ? Number((1 - accuracy).toFixed(3)) * 2.4 : 0;
  score += staleDays !== null ? Math.min(1.5, staleDays / 8) : 0.4;
  score -= Math.abs(difficulty - ((band.min + band.max) / 2)) * 0.2;

  return {
    score: Number(score.toFixed(4)),
    difficulty,
    status,
    range,
    reviewed,
    accuracy: Number((accuracy * 100).toFixed(2)),
    staleDays,
  };
}

function buildTopRecommendations(rulePlan, summary) {
  const cards = [];
  cards.push({
    id: 'daily-load',
    title: `Today's load: ${rulePlan.dailyWordTarget} words`,
    detail: rulePlan.activityAdjustment > 0
      ? `You earned +${rulePlan.activityAdjustment} extra words because your recent activity is strong.`
      : `The system reduced today's load by ${Math.abs(rulePlan.activityAdjustment)} words to keep retention realistic.`,
    tone: rulePlan.activityAdjustment > 0 ? 'positive' : 'steady',
  });

  if (summary.struggling > 0) {
    cards.push({
      id: 'struggling-focus',
      title: `Focus on ${summary.struggling} struggling words`,
      detail: 'Start with recall and spelling before moving into quiz pressure.',
      tone: 'priority',
    });
  }

  if (summary.reviewQueue > 0) {
    cards.push({
      id: 'review-queue',
      title: `${summary.reviewQueue} review words are queued`,
      detail: 'Older items are being recycled first so you do not lose previous gains.',
      tone: 'info',
    });
  }

  cards.push({
    id: 'difficulty-band',
    title: `Band ${rulePlan.difficultyBand.min}-${rulePlan.difficultyBand.max} for ${rulePlan.grade}`,
    detail: `${summary.inBand}/${summary.totalPool} words match your current level filter.`,
    tone: 'info',
  });

  return cards.slice(0, 4);
}

function resolveDailyWordTarget(minutesPerDay, grade, isActive) {
  const safeMinutes = clampNumber(minutesPerDay, 10, 180, 25);
  const baseline = Math.round((safeMinutes / 2.2) * gradeWordMultiplier(grade));
  const adjusted = baseline + (isActive ? 5 : -5);
  return {
    minutesPerDay: safeMinutes,
    baseWords: clampNumber(baseline, 5, 50, 12),
    finalWords: clampNumber(adjusted, 5, 55, 12),
    activityAdjustment: isActive ? 5 : -5,
  };
}

function buildModeMix(minutesPerDay, grade) {
  const weightsByGrade = {
    A1: { flashcards: 0.5, quiz: 0.18, matching: 0.2, spelling: 0.12 },
    A2: { flashcards: 0.44, quiz: 0.22, matching: 0.2, spelling: 0.14 },
    B1: { flashcards: 0.36, quiz: 0.28, matching: 0.2, spelling: 0.16 },
    B2: { flashcards: 0.3, quiz: 0.32, matching: 0.21, spelling: 0.17 },
    C1: { flashcards: 0.25, quiz: 0.36, matching: 0.22, spelling: 0.17 },
    C2: { flashcards: 0.22, quiz: 0.39, matching: 0.21, spelling: 0.18 },
  };
  const weights = weightsByGrade[grade] || weightsByGrade.B1;
  const modes = Object.keys(weights);
  const blocks = modes.map((mode) => ({
    mode,
    minutes: Math.max(1, Math.round(minutesPerDay * weights[mode])),
  }));
  const delta = minutesPerDay - blocks.reduce((sum, b) => sum + b.minutes, 0);
  if (delta !== 0) blocks[0].minutes = Math.max(1, blocks[0].minutes + delta);
  return blocks;
}

function buildDeterministicWeeklyPlan(options = {}) {
  const days = clampNumber(options.days, 5, 7, 7);
  const grade = normalizeEnglishGrade(options.grade);
  const resolvedGrade = grade === 'AUTO' ? inferGradeFromSignals(options.progress) : grade;
  const hearts = clampNumber(options.hearts, 0, 5, 5);
  const activeSignal = options.activeSignal === true
    || (Number(options.progress?.streak || 0) >= 3 && Number(options.progress?.accuracy || 0) >= 75);
  const target = resolveDailyWordTarget(options.minutesPerDay, resolvedGrade, activeSignal);
  if (hearts <= 2) {
    target.finalWords = clampNumber(target.finalWords - 3, 5, 55, target.finalWords);
  }
  const band = difficultyBandForGrade(resolvedGrade);
  const modeMix = buildModeMix(target.minutesPerDay, resolvedGrade);

  const pool = Array.isArray(options.words) ? options.words : [];
  const filteringSummary = buildFilteringSummary(pool, band, resolvedGrade);
  const ranked = pool
    .map((word) => {
      const scoreMeta = scoreWordForWeeklyPlan(word, band, resolvedGrade);
      return {
        ...word,
        _score: scoreMeta.score,
        _scoreMeta: scoreMeta,
      };
    })
    .sort((a, b) => b._score - a._score);

  const today = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dailyPlan = [];
  let cursor = 0;

  for (let i = 0; i < days; i += 1) {
    const dayDate = new Date(today);
    dayDate.setDate(today.getDate() + i);
    const dayWords = ranked.slice(cursor, cursor + target.finalWords);
    if (dayWords.length < target.finalWords && ranked.length) {
      const missing = target.finalWords - dayWords.length;
      dayWords.push(...ranked.slice(0, missing));
    }
    cursor = (cursor + target.finalWords) % Math.max(ranked.length || 1, 1);

    dailyPlan.push({
      dayIndex: i + 1,
      dayName: dayNames[dayDate.getDay()],
      date: dayDate.toISOString().slice(0, 10),
      targetWords: target.finalWords,
      minutes: target.minutesPerDay,
      difficultyBand: band,
      recommendation: i === 0
        ? 'Start with the most fragile words first, then move into quiz pressure.'
        : i % 2 === 0
          ? 'Balance review and challenge to strengthen recall under time pressure.'
          : 'Use visual and spelling practice to lock in new vocabulary before testing.',
      focusModes: modeMix,
      wordIds: dayWords.map((w) => String(w._id || w.id || '')),
      wordsPreview: dayWords.slice(0, 8).map((w) => ({
        id: String(w._id || w.id || ''),
        word: String(w.word || ''),
        difficulty: clampNumber(w.difficulty, 1, 5, 3),
        learningStatus: normalizeLearningStatus(w.learningStatus),
      })),
    });
  }

  const topRecommendations = buildTopRecommendations({
    grade: resolvedGrade,
    dailyWordTarget: target.finalWords,
    activityAdjustment: target.activityAdjustment,
    difficultyBand: band,
  }, filteringSummary);
  if (hearts <= 2) {
    topRecommendations.unshift({
      id: 'low-hearts',
      title: `Only ${hearts} hearts left`,
      detail: 'Switch to safer review and stabilization before heavy quiz pressure.',
      tone: 'steady',
    });
  }

  return {
    source: 'rule-engine',
    grade: resolvedGrade,
    requestedGrade: grade,
    activeSignal,
    heartState: {
      count: hearts,
      lowHearts: hearts <= 2,
    },
    days,
    activityAdjustment: target.activityAdjustment,
    dailyWordTarget: target.finalWords,
    baseWordTarget: target.baseWords,
    minutesPerDay: target.minutesPerDay,
    difficultyBand: band,
    filteringSummary,
    topRecommendations,
    dailyPlan,
  };
}

function parseJsonFromModelText(rawText) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return tryParseJsonWithRepair(fenced[1]);
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return tryParseJsonWithRepair(arrayMatch[0]);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) return tryParseJsonWithRepair(objectMatch[0]);
  return { _rawText: text };
}

function extractWordArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.words)) return payload.words;
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.data && Array.isArray(payload.data.words)) return payload.data.words;
  return [];
}

function normalizeClarifyLevelAiPayload(aiPayload, fallbackGrade) {
  if (aiPayload && !aiPayload._rawText) return aiPayload;
  const text = String(aiPayload?._rawText || '').trim();
  return {
    grade: fallbackGrade,
    summary: text || `Current estimated grade: ${fallbackGrade}.`,
    strengths: [],
    gaps: [],
    nextWeekFocus: [],
  };
}

function normalizeWeeklyScheduleAiPayload(aiPayload, rulePlan) {
  if (aiPayload && !aiPayload._rawText) return aiPayload;
  const text = String(aiPayload?._rawText || '').trim();
  const firstDay = Array.isArray(rulePlan?.dailyPlan) ? rulePlan.dailyPlan[0] : null;
  const order = Array.isArray(firstDay?.focusModes)
    ? firstDay.focusModes.map((item) => String(item.mode || '')).filter(Boolean)
    : ['flashcards', 'quiz', 'matching', 'spelling'];
  return {
    weeklySummary: text || 'Follow the structured weekly progression and keep review first when accuracy drops.',
    dailySpotlight: {
      dayIndex: 1,
      title: `Start with ${order[0] || 'flashcards'} today`,
      detail: firstDay?.recommendation || 'Open the first exercise in your sequence and finish the review block before moving on.',
      startMode: order[0] || 'flashcards',
    },
    adaptiveOrdering: [
      {
        dayIndex: 1,
        order,
        reason: 'Fallback ordering derived from the daily mode mix.',
      },
    ],
    coachNotes: [],
    dailyExplanations: [],
    recommendationCards: rulePlan.topRecommendations || [],
  };
}

function tryParseJsonWithRepair(rawText) {
  const source = String(rawText || '').trim();
  try {
    return JSON.parse(source);
  } catch (_err) {
    const repaired = source
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .trim();
    return JSON.parse(repaired);
  }
}

function extractInteractionText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    const content = Array.isArray(step?.content) ? step.content : [];
    const text = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }

  return '';
}

function extractGenerateContentText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const direct = String(payload.text || '').trim();
  if (direct) return direct;

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text) return text;
  }

  return '';
}

function normalizeGeminiModelForGenerateContent(model) {
  const raw = String(model || '').trim();
  if (!raw) return 'models/gemini-1.5-flash';
  if (raw.startsWith('models/')) return raw;
  return `models/${raw}`;
}

function shouldRetryGemini(statusCode) {
  const code = Number(statusCode || 0);
  return code === 408 || code === 409 || code === 429 || code >= 500;
}

function shouldFallbackGeminiApi(statusCode) {
  const code = Number(statusCode || 0);
  return code === 400 || code === 404 || code === 405;
}

async function callGeminiViaGenerateContent(prompt) {
  const modelPath = normalizeGeminiModelForGenerateContent(GEMINI_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

  const response = await axios.post(url, {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.15,
      topP: 0.8,
      maxOutputTokens: 1400,
      responseMimeType: 'application/json',
    },
  }, {
    timeout: 25000,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
  });

  const text = extractGenerateContentText(response?.data);
  if (!text) throw new Error('Gemini returned an empty response.');
  return parseJsonFromModelText(text);
}

async function callGeminiViaInteractions(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const response = await axios.post(url, {
    model: GEMINI_MODEL,
    input: [
      {
        type: 'user_input',
        content: [{ type: 'text', text: prompt }],
      },
    ],
    generation_config: {
      temperature: 0.15,
      top_p: 0.8,
      max_output_tokens: 1400,
    },
  }, {
    timeout: 25000,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
  });

  const text = extractInteractionText(response?.data);
  if (!text) throw new Error('Gemini returned an empty response.');
  return parseJsonFromModelText(text);
}

async function callGeminiForJson(prompt) {
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const mode = GEMINI_API_MODE;
  const preferGenerate = mode === 'generatecontent' || mode === 'auto';
  const preferInteractions = mode === 'interactions';

  const chain = preferInteractions
    ? [callGeminiViaInteractions, callGeminiViaGenerateContent]
    : [callGeminiViaGenerateContent, callGeminiViaInteractions];

  let lastError = null;

  for (let i = 0; i < chain.length; i += 1) {
    const candidateCall = chain[i];
    let candidateError = null;

    for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt += 1) {
      try {
        return await candidateCall(prompt);
      } catch (err) {
        candidateError = err;
        lastError = err;
        const status = err?.response?.status;
        if (shouldRetryGemini(status) && attempt < GEMINI_MAX_RETRIES - 1) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        break;
      }
    }

    if (!candidateError) break;
    const status = candidateError?.response?.status;
    if (!shouldFallbackGeminiApi(status)) {
      throw candidateError;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

async function resolveLearnerContext(userId) {
  if (!isDbConnected()) {
    const store = devStore.readStore();
    const user = (store.users || []).find((u) => String(u._id) === String(userId));
    if (!user) return null;

    let ownerIds = [String(user._id)];
    if (String(user.role || 'student') === 'student') {
      if (GLOBAL_WORD_SCOPE) {
        ownerIds = ['*'];
      } else {
        const linkedCode = String(user.linkedCreatorCode || '').trim().toUpperCase();
        const creator = (store.users || []).find((u) => String(u.creatorCode || '').trim().toUpperCase() === linkedCode);
        ownerIds = creator ? [String(creator._id)] : [];
      }
    }

    const words = ownerIds.includes('*')
      ? (store.words || [])
      : (store.words || []).filter((w) => ownerIds.includes(String(w.userId)));
    const progress = (store.progress || []).find((p) => String(p.userId) === String(userId)) || null;
    return { user, words, progress };
  }

  const user = await User.findById(userId).select('role creatorCode linkedCreatorCode name').lean();
  if (!user) return null;

  let ownerIds = [String(user._id)];
  if (String(user.role || 'student') === 'student') {
    if (GLOBAL_WORD_SCOPE) {
      ownerIds = ['*'];
    } else {
      const linkedCode = String(user.linkedCreatorCode || '').trim().toUpperCase();
      if (linkedCode) {
        const creator = await User.findOne({ creatorCode: linkedCode }).select('_id').lean();
        ownerIds = creator ? [String(creator._id)] : [];
      } else {
        ownerIds = [];
      }
    }
  }

  const query = ownerIds.includes('*') ? {} : { userId: { $in: ownerIds } };
  const words = ownerIds.length
    ? await Word.find(query).select('word definition difficulty timesReviewed timesCorrect learningStatus targetScoreRange').lean()
    : [];
  const progress = await Progress.findOne({ userId: String(userId) }).lean();
  return { user, words: words || [], progress: progress || null };
}

function extractKeywords(text, max = 4) {
  const stopWords = new Set(['a','an','the','and','or','with','without','for','of','to','in','on','at','from','by','is','are','be','this','that','these','those','into','onto','over','under','very','some','any','about','around','your','our','their','my','its','his','her','as','than','then','but','so','such','more','most','less','few','many','much','through','during','while','before','after']);
  const seen = new Set();
  return safeText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !stopWords.has(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    })
    .slice(0, max);
}

function buildPexelsQueries(word, definition, prompt) {
  const queries = [];
  const cleanPrompt = safeText(prompt);
  if (cleanPrompt) queries.push(cleanPrompt);

  const cleanWord = safeText(word);
  const keywords = extractKeywords(definition, 4);
  if (cleanWord && keywords.length) queries.push(`${cleanWord} ${keywords.join(' ')}`);
  if (cleanWord) queries.push(cleanWord);
  return Array.from(new Set(queries)).slice(0, 4);
}

function scorePexelsPhoto(query, photo) {
  const queryTokens = extractKeywords(query, 8);
  const alt = safeText(photo && photo.alt).toLowerCase();
  const url = safeText(photo && photo.url).toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (alt.includes(token)) score += 3;
    if (url.includes(token)) score += 1;
  }
  return score;
}

async function fetchPexelsImage(word, definition, prompt) {
  if (!PEXELS_API_KEY) {
    const err = new Error('Pexels API key not configured. Add PEXELS_API_KEY to .env.');
    err.statusCode = 503;
    throw err;
  }

  const queries = buildPexelsQueries(word, definition, prompt);
  if (!queries.length) {
    const err = new Error('Could not build a Pexels search query.');
    err.statusCode = 400;
    throw err;
  }

  for (const query of queries) {
    const response = await axios.get('https://api.pexels.com/v1/search', {
      timeout: 15000,
      params: {
        query,
        per_page: 5,
        orientation: 'landscape',
        size: 'medium',
      },
      headers: {
        Authorization: PEXELS_API_KEY,
      },
    });

    const photos = Array.isArray(response.data && response.data.photos) ? response.data.photos : [];
    if (!photos.length) continue;

    const best = photos
      .map((photo) => ({ photo, score: scorePexelsPhoto(query, photo) }))
      .sort((a, b) => b.score - a.score)[0];

    const selected = best && best.photo;
    const remoteUrl = safeText(selected && selected.src && (selected.src.large2x || selected.src.large || selected.src.landscape || selected.src.medium));
    if (!remoteUrl) continue;

    return {
      remoteUrl,
      photographer: safeText(selected.photographer),
      photoPage: safeText(selected.url),
    };
  }

  const err = new Error('No matching Pexels image was found for this description.');
  err.statusCode = 404;
  throw err;
}

function escapeSvgText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createLocalFallbackSvg(word, prompt) {
  const safeWord = escapeSvgText(word || 'Vocabulary');
  const safePrompt = escapeSvgText(String(prompt || '').slice(0, 120));
  const filename = `fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.svg`;
  const filepath = path.join(GENERATED_DIR, filename);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Fallback image for ${safeWord}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="430" cy="82" r="58" fill="#334155" opacity="0.5"/>
  <circle cx="94" cy="430" r="72" fill="#1d4ed8" opacity="0.18"/>
  <text x="36" y="210" fill="#e2e8f0" font-size="44" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${safeWord}</text>
  <text x="36" y="250" fill="#93c5fd" font-size="18" font-family="Segoe UI, Arial, sans-serif">AI preview unavailable</text>
  <foreignObject x="36" y="276" width="440" height="180">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#94a3b8;font:14px 'Segoe UI',Arial,sans-serif;line-height:1.35;">${safePrompt}</div>
  </foreignObject>
</svg>`;
  fs.writeFileSync(filepath, svg, 'utf8');
  return `/generated/${filename}`;
}

// POST /api/ai/generate — auto-fill definition & example for a word
router.post('/generate', async (req, res) => {
  try {
    const { word, partOfSpeech } = req.body;
    if (!word) return res.status(400).json({ message: 'Word is required.' });
    if (typeof word !== 'string' || word.trim().length === 0 || word.length > 100) {
      return res.status(400).json({ message: 'Word must be a string between 1-100 characters.' });
    }
    if (partOfSpeech && (typeof partOfSpeech !== 'string' || partOfSpeech.length > 50)) {
      return res.status(400).json({ message: 'Part of speech must be a string up to 50 characters.' });
    }

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `For the English word "${word}"${partOfSpeech ? ` (${partOfSpeech})` : ''}, provide:
1. A clear, concise definition (1-2 sentences)
2. One natural example sentence using the word in context
3. The part of speech

Respond ONLY with valid JSON in this exact format:
{"definition":"...","example":"...","partOfSpeech":"noun|verb|adjective|adverb|phrase|idiom|other"}`
      }],
      max_tokens: 300,
      temperature: 0.5,
    });

    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ message: 'AI returned unexpected format.' });
    const data = JSON.parse(match[0]);
    res.json(data);
  } catch (err) {
    console.error('AI generate error:', err.message);
    res.status(500).json({ message: 'AI request failed: ' + err.message });
  }
});

// POST /api/ai/chat — AI tutor conversation
router.post('/chat', async (req, res) => {
  try {
    const { messages, wordList } = req.body;
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ message: 'Messages array is required.' });
    if (messages.length > 100) return res.status(400).json({ message: 'Too many messages.' });
    if (!messages.every((m) => m.role && m.content && typeof m.content === 'string')) {
      return res.status(400).json({ message: 'Invalid message format.' });
    }
    if (messages.some((m) => m.content.length > 5000)) {
      return res.status(400).json({ message: 'Message content too long (max 5000 chars).' });
    }

    const openai = getOpenAI();
    const systemPrompt = {
      role: 'system',
      content: `You are VocabMaster AI, a friendly, encouraging, and knowledgeable English vocabulary tutor.
Your goal is to help users learn and remember vocabulary effectively.
You can: explain word meanings and origins, create example sentences, give mnemonics, quiz users, suggest related words.
Be concise, clear, and supportive. Use emojis sparingly to be friendly.
The user's current vocabulary list: ${wordList && wordList.length ? wordList.join(', ') : '(no words saved yet)'}.`
    };

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [systemPrompt, ...messages.slice(-18)],
      max_tokens: 600,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content.trim();
    res.json({ reply });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ message: 'AI request failed: ' + err.message });
  }
});

// POST /api/ai/quiz-generate — generate quiz questions from word list
router.post('/quiz-generate', async (req, res) => {
  try {
    const { words, count } = req.body;
    if (!words || !Array.isArray(words) || words.length < 2)
      return res.status(400).json({ message: 'At least 2 words are required to generate a quiz.' });
    if (words.length > 50) return res.status(400).json({ message: 'Too many words (max 50).' });
    if (!words.every((w) => w.word && typeof w.word === 'string' && w.definition && typeof w.definition === 'string')) {
      return res.status(400).json({ message: 'Invalid word format.' });
    }
    if (words.some((w) => w.word.length > 100 || w.definition.length > 500)) {
      return res.status(400).json({ message: 'Word or definition exceeds length limit.' });
    }
    const numCount = parseInt(count) || 5;
    if (numCount < 1 || numCount > 20) return res.status(400).json({ message: 'Question count must be between 1-20.' });

    const openai = getOpenAI();
    const wordSample = words.slice(0, 20);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Generate ${numCount} multiple choice vocabulary quiz questions from this list:
${wordSample.map(w => `- ${w.word}: ${w.definition}`).join('\n')}

For each question:
- Ask for the definition of a word, OR ask which word matches a definition
- Provide 4 options (1 correct, 3 plausible wrong ones from the list or invented)

Respond ONLY with a JSON array in this format:
[{"question":"What is the meaning of 'serendipity'?","options":["A lucky discovery","A type of flower","An old building","A musical term"],"answer":"A lucky discovery","word":"serendipity"}]`
      }],
      max_tokens: 1200,
      temperature: 0.8,
    });

    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ message: 'AI returned unexpected format.' });
    const questions = JSON.parse(match[0]);
    res.json({ questions });
  } catch (err) {
    console.error('AI quiz generate error:', err.message);
    res.status(500).json({ message: 'AI request failed: ' + err.message });
  }
});


// POST /api/ai/enrich-words — take a user-supplied word list, add definitions/examples via AI
router.post('/enrich-words', async (req, res) => {
  try {
    const { words } = req.body;

    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ message: 'Provide a non-empty array of words.' });
    }
    if (words.length > 60) {
      return res.status(400).json({ message: 'Maximum 60 words per request.' });
    }

    const cleaned = words
      .map((w) => String(w || '').trim())
      .filter((w) => w.length > 0 && w.length <= 100)
      .slice(0, 60);

    if (!cleaned.length) {
      return res.status(400).json({ message: 'No valid words found.' });
    }

    const groqModel = String(process.env.GROQ_MODEL || 'canopylabs/orpheus-v1-english').trim();
    const groq = getGroq();
    console.info('AI enrich-words request using Groq model:', groqModel, 'words:', cleaned.length);
    const completion = await groq.chat.completions.create({
      model: groqModel,
      messages: [{
        role: 'user',
        content: `For each word in this list, provide a clear definition, a natural example sentence, and the part of speech.

Words: ${cleaned.map((w, i) => `${i + 1}. ${w}`).join('\n')}

Rules:
- One entry per word, in the same order.
- Definition: 1–2 clear sentences, not just a synonym.
- Example: a realistic sentence using the word in context.
- Part of speech: one of noun, verb, adjective, adverb, phrase, idiom, other.

Respond ONLY with a valid JSON array, no markdown, no explanation:
[{"word":"...","definition":"...","example":"...","partOfSpeech":"..."}]`
      }],
      max_tokens: 4000,
      temperature: 0.4,
    });

    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return res.status(500).json({ message: 'AI returned unexpected format.' });

    let enriched;
    try {
      enriched = JSON.parse(match[0]);
    } catch {
      return res.status(500).json({ message: 'AI response could not be parsed.' });
    }

    const normalized = normalizeGeneratedWordList(enriched);
    const byWord = new Map(normalized.map((item) => [String(item.word || '').trim().toLowerCase(), item]));
    const result = cleaned.map((word) => {
      const match = byWord.get(String(word || '').trim().toLowerCase());
      return match || {
        word: String(word || '').trim().slice(0, 100),
        definition: buildFallbackDefinition(word),
        example: buildFallbackExample(word, buildFallbackDefinition(word)),
        partOfSpeech: 'other',
      };
    }).slice(0, 60);

    // Include provider/model info so frontend can show which provider responded
    console.info('AI enrich-words response provider=groq model=' + groqModel + ' returned words=' + result.length);
    res.json({ words: result, provider: 'groq', model: groqModel });
  } catch (err) {
    console.error('AI enrich-words error:', err.message);
    res.status(500).json({ message: 'AI request failed: ' + err.message });
  }
});

// POST /api/ai/generate-vocab — generate a list of vocabulary words for a given topic/level
router.post('/generate-vocab', async (req, res) => {
  try {
    const { topic, count, difficulty, partOfSpeech } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0 || topic.length > 200) {
      return res.status(400).json({ message: 'Topic is required (max 200 chars).' });
    }

    const numWords = Math.min(Math.max(parseInt(count) || 10, 1), 40);
    const level = ['beginner', 'intermediate', 'advanced', 'expert'].includes(difficulty)
      ? difficulty
      : 'intermediate';
    const posHint = partOfSpeech && typeof partOfSpeech === 'string' ? ` Focus on ${partOfSpeech} words.` : '';

    const generationPrompt = `Generate exactly ${numWords} vocabulary words related to: "${topic.trim()}".
Difficulty level: ${level}.${posHint}

Rules:
- Each word must be distinct and genuinely useful for English learners.
- Include a clear definition (1–2 sentences, not just a synonym).
- Include a natural example sentence using the word in context.
- Identify the correct part of speech (noun, verb, adjective, adverb, phrase, idiom, or other).

Respond ONLY with a valid JSON array. No markdown, no explanation. Format:
[{"word":"...","definition":"...","example":"...","partOfSpeech":"..."}]`;

    const generated = await generateWordListWithFallback(generationPrompt, {
      topic: topic.trim(),
      numWords,
      level,
    });
    if (!Array.isArray(generated.words)) {
      return res.status(500).json({ message: 'AI did not return a word list.' });
    }

    const clean = normalizeGeneratedWordList(generated.words);

    res.json({
      words: clean,
      topic: topic.trim(),
      difficulty: level,
      provider: generated.provider,
      providerErrors: generated.providerErrors || [],
    });
  } catch (err) {
    console.error('AI generate-vocab error:', err.message);
    const status = Number((err && err.statusCode) || (err && err.response && err.response.status) || 500);
    res.status(status).json({ message: 'AI request failed: ' + err.message });
  }
});

// POST /api/ai/generate-word-image — use Groq to write prompt, then Pollinations (free) to generate image, save locally
router.post('/generate-word-image', async (req, res) => {
  try {
    const { word, definition, partOfSpeech, customPrompt } = req.body;
    if (!word && !customPrompt) {
      return res.status(400).json({ message: 'word or customPrompt is required.' });
    }

    let prompt = safeText(customPrompt || '');
    if (!prompt) {
      const descriptor = safeText(definition || '').slice(0, 140);
      const posHint = safeText(partOfSpeech || '');
      prompt = `${safeText(word || 'vocabulary')} ${descriptor} ${posHint}`.trim();
    }

    let imageBuffer = null;
    let provider = '';
    let attribution = '';
    let attributionUrl = '';

    try {
      const pexelsImage = await fetchPexelsImage(word, definition, prompt);
      const imageResponse = await axios.get(pexelsImage.remoteUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: {
          Accept: 'image/*,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      imageBuffer = imageResponse.data;
      provider = 'pexels';
      attribution = pexelsImage.photographer ? `Photo by ${pexelsImage.photographer} on Pexels` : 'Photo from Pexels';
      attributionUrl = pexelsImage.photoPage || 'https://www.pexels.com';
    } catch (pexelsErr) {
      console.warn('Pexels image fallback:', pexelsErr.message);
      const polPrompt = `${prompt}. photorealistic, clean composition, no text overlays`;
      try {
        imageBuffer = await fetchPollinationsImageWithRetry(polPrompt, 3);
        provider = 'pollinations';
        attribution = 'Generated via Pollinations';
        attributionUrl = 'https://image.pollinations.ai';
      } catch (pollErr) {
        console.warn('Pollinations image fallback:', pollErr.message);
        const fallbackUrl = createLocalFallbackSvg(word, prompt);
        return res.json({
          word: safeText(word),
          prompt,
          imageUrl: fallbackUrl,
          provider: 'local-fallback',
          attribution: 'Generated local fallback card',
          attributionUrl: '',
        });
      }
    }

    if (!imageBuffer || (imageBuffer.length !== undefined && imageBuffer.length < 512)) {
      const fallbackUrl = createLocalFallbackSvg(word, prompt);
      return res.json({
        word: safeText(word),
        prompt,
        imageUrl: fallbackUrl,
        provider: 'local-fallback',
        attribution: 'Generated local fallback card',
        attributionUrl: '',
      });
    }

    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const filepath = path.join(GENERATED_DIR, filename);
    fs.writeFileSync(filepath, imageBuffer);

    const imageUrl = `/generated/${filename}`;
    return res.json({
      word: safeText(word),
      prompt,
      imageUrl,
      provider,
      attribution,
      attributionUrl,
    });
  } catch (err) {
    const status = (err && err.statusCode) || (err && err.response && err.response.status);
    console.error('AI generate-word-image error:', status || '-', err.message);

    if (status === 503 && /pexels api key not configured/i.test(String(err.message || ''))) {
      return res.status(503).json({ message: 'Pexels API key not configured. Add PEXELS_API_KEY to .env.' });
    }

    if (status === 503) {
      return res.status(503).json({ message: 'Image model is loading. Try again in 20 seconds.' });
    }

    if (status === 429) {
      return res.status(429).json({ message: 'Image provider is rate-limited. Please try again in about 30 seconds.' });
    }

    if (status === 404) {
      return res.status(404).json({ message: err.message || 'No matching image was found.' });
    }

    if (status >= 500) {
      return res.status(502).json({ message: 'Image provider is temporarily unavailable. Please try again shortly.' });
    }

    if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
      return res.status(504).json({ message: 'Image generation timed out. Please try again.' });
    }

    res.status(500).json({ message: 'Image generation failed: ' + err.message });
  }
});

// POST /api/ai/suggest-deck — suggest a deck name/topic/difficulty from a list of words
router.post('/suggest-deck', async (req, res) => {
  try {
    const { words } = req.body;
    const list = Array.isArray(words) ? words.slice(0, 60).map(String) : [];
    if (!list.length) return res.status(400).json({ message: 'Provide an array of words (at least 1).' });

    const groqModel = String(process.env.GROQ_MODEL || 'canopylabs/orpheus-v1-english').trim();
    const groq = getGroq();
    console.info('AI suggest-deck using model:', groqModel, 'words:', list.length);

    const prompt = `You are a helpful assistant that suggests a compact deck metadata for vocabulary study.
Given this list of words (comma or newline separated), propose:
- name: a short deck name (3-5 words)
- topic: a concise topic/tag
- difficulty: one of beginner, intermediate, advanced
- description: a short 1-2 sentence description suitable for display.

Respond ONLY with valid JSON exactly like:
{"name":"...","topic":"...","difficulty":"intermediate","description":"..."}

Words:\n${list.join('\n')}`;

    const completion = await groq.chat.completions.create({
      model: groqModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    });

    const raw = completion && completion.choices && completion.choices[0] && completion.choices[0].message
      ? String(completion.choices[0].message.content || '').trim()
      : '';
    const jsonText = extractJsonArrayText(raw) || (() => { const m = raw.match(/\{[\s\S]*\}/); return m ? m[0] : ''; })();
    if (!jsonText) return res.status(500).json({ message: 'AI returned unexpected format.' });

    let obj;
    try { obj = JSON.parse(jsonText); } catch (e) { return res.status(500).json({ message: 'AI response could not be parsed.' }); }

    // normalize fields
    obj.name = String(obj.name || '').trim().slice(0, 120) || 'New Vocabulary Deck';
    obj.topic = String(obj.topic || '').trim().slice(0, 200) || '';
    obj.difficulty = ['beginner','intermediate','advanced'].includes(String(obj.difficulty || '').toLowerCase()) ? String(obj.difficulty).toLowerCase() : 'intermediate';
    obj.description = String(obj.description || '').trim().slice(0, 500) || '';

    console.info('AI suggest-deck result:', obj.name, obj.topic, obj.difficulty);
    res.json({ suggestion: obj, provider: 'groq', model: groqModel });
  } catch (err) {
    console.error('AI suggest-deck error:', err.message);
    res.status(500).json({ message: 'AI request failed: ' + err.message });
  }
});

// POST /api/ai/save-word-image — save an imageUrl to a word record
router.post('/save-word-image', async (req, res) => {
  try {
    const { wordId, imageUrl } = req.body;
    if (!wordId || !imageUrl) return res.status(400).json({ message: 'wordId and imageUrl are required.' });
    if (typeof imageUrl !== 'string') {
      return res.status(400).json({ message: 'Invalid imageUrl.' });
    }

    const { isDbConnected } = require('../config/db');
    const devStore = require('../services/devStore');
    const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';

    if (!isDbConnected()) {
      const updated = GLOBAL_WORD_SCOPE
        ? devStore.updateWordGlobal(wordId, { imageUrl })
        : devStore.updateWord(wordId, req.user.id, { imageUrl });
      if (!updated) return res.status(404).json({ message: 'Word not found.' });
      return res.json({ word: updated, imageUrl });
    }

    const Word = require('../models/Word');
    const word = await Word.findById(wordId);
    if (!word) return res.status(404).json({ message: 'Word not found.' });
    word.imageUrl = imageUrl;
    await word.save();
    res.json({ word, imageUrl });
  } catch (err) {
    console.error('AI save-word-image error:', err.message);
    res.status(500).json({ message: 'Failed to save image.' });
  }
});

// POST /api/ai/upload-word-image — upload a user-provided card image and return local URL
router.post('/upload-word-image', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.filename) {
      return res.status(400).json({ message: 'Image file is required.' });
    }

    return res.json({
      imageUrl: `/generated/${req.file.filename}`,
      provider: 'upload',
    });
  } catch (err) {
    console.error('AI upload-word-image error:', err.message);
    return res.status(500).json({ message: 'Failed to upload image.' });
  }
});

// POST /api/ai/clarify-level - explain learner level and recommendations
router.post('/clarify-level', async (req, res) => {
  try {
    const context = await resolveLearnerContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    const requestedGrade = normalizeEnglishGrade(req.body.englishGrade);
    const snapshot = {
      totalXP: Number(context.progress?.totalXP || 0),
      accuracy: Number(context.progress?.accuracy || 0),
      streak: Number(context.progress?.streak || 0),
      lessonsCompleted: Number(context.progress?.lessonsCompleted || 0),
    };
    const inferredGrade = inferGradeFromSignals(snapshot);
    const resolvedGrade = requestedGrade === 'AUTO' ? inferredGrade : requestedGrade;
    const band = difficultyBandForGrade(resolvedGrade);

    const basePayload = {
      grade: resolvedGrade,
      inferredGrade,
      requestedGrade,
      difficultyBand: band,
      metrics: snapshot,
      recommendation: {
        nextFocus: snapshot.accuracy < 70 ? 'Build recall accuracy with more flashcards and spelling.' : 'Increase challenge with quizzes and matching speed rounds.',
        weeklyGoal: snapshot.accuracy < 70 ? 'Stabilize at 75%+ average accuracy.' : 'Push to next level with tougher mixed sessions.',
      },
    };

    if (!GEMINI_API_KEY) {
      return res.json({
        ...basePayload,
        source: 'rule-engine',
        aiUsed: false,
      });
    }

    const aiPrompt = `You are an expert ESL assessor.
Return ONLY valid JSON:
{
  "grade":"A1|A2|B1|B2|C1|C2",
  "summary":"short explanation",
  "strengths":["..."],
  "gaps":["..."],
  "nextWeekFocus":["..."]
}

Constraints:
- Keep grade as ${resolvedGrade} unless evidence is very strong for one adjacent level.
- Keep summary under 55 words.

Learner data:
${JSON.stringify(basePayload, null, 2)}`;

    try {
      const ai = normalizeClarifyLevelAiPayload(await callGeminiForJson(aiPrompt), resolvedGrade);
      return res.json({
        ...basePayload,
        source: 'gemini',
        aiUsed: true,
        ai,
      });
    } catch (aiErr) {
      console.error('AI clarify-level fallback:', aiErr.message);
      return res.json({
        ...basePayload,
        source: 'rule-engine',
        aiUsed: false,
        aiError: aiErr.message,
      });
    }
  } catch (err) {
    console.error('AI clarify-level error:', err.message);
    return res.status(500).json({ message: 'Failed to clarify learner level.' });
  }
});

// POST /api/ai/weekly-schedule - build weekly schedule with rule-safe AI enrichment
router.post('/weekly-schedule', async (req, res) => {
  try {
    const context = await resolveLearnerContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    const rulePlan = buildDeterministicWeeklyPlan({
      days: req.body.days,
      grade: req.body.englishGrade,
      activeSignal: req.body.activeSignal,
      minutesPerDay: req.body.minutesPerDay,
      progress: {
        totalXP: Number(context.progress?.totalXP || 0),
        accuracy: Number(context.progress?.accuracy || 0),
        streak: Number(context.progress?.streak || 0),
        lessonsCompleted: Number(context.progress?.lessonsCompleted || 0),
      },
      hearts: req.body.hearts,
      words: context.words,
    });

    if (!GEMINI_API_KEY) {
      return res.json({
        ...rulePlan,
        source: 'rule-engine',
        aiUsed: false,
      });
    }

    const aiPrompt = `You are an expert English learning scheduler.
Use the provided deterministic plan and improve sequencing only.
You MUST preserve day count, dailyWordTarget, minutesPerDay, and difficultyBand.
Return ONLY valid JSON in this shape:
{
  "weeklySummary":"<=70 words",
  "dailySpotlight":{"dayIndex":1,"title":"short","detail":"short","startMode":"flashcards|quiz|matching|spelling"},
  "adaptiveOrdering":[{"dayIndex":1,"order":["flashcards","quiz","matching","spelling"],"reason":"short"}],
  "coachNotes":["..."],
  "dailyExplanations":[{"dayIndex":1,"explanation":"short"}],
  "recommendationCards":[{"id":"daily-load","title":"short","detail":"short","tone":"positive|steady|priority|info"}]
}

Deterministic plan:
${JSON.stringify(rulePlan, null, 2)}`;

    try {
      const ai = normalizeWeeklyScheduleAiPayload(await callGeminiForJson(aiPrompt), rulePlan);
      return res.json({
        ...rulePlan,
        source: 'gemini+rules',
        aiUsed: true,
        ai,
      });
    } catch (aiErr) {
      console.error('AI weekly-schedule fallback:', aiErr.message);
      return res.json({
        ...rulePlan,
        source: 'rule-engine',
        aiUsed: false,
        aiError: aiErr.message,
      });
    }
  } catch (err) {
    console.error('AI weekly-schedule error:', err.message);
    return res.status(500).json({ message: 'Failed to build weekly schedule.' });
  }
});

module.exports = router;
module.exports.__internals = {
  normalizeGeneratedWordList,
  buildFallbackDefinition,
  buildFallbackExample,
};
