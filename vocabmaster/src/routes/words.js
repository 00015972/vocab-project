const express = require('express');
const router = express.Router();
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const Word = require('../models/Word');
const Deck = require('../models/Deck');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';
const IMAGE_PROVIDER = String(process.env.IMAGE_PROVIDER || 'wikipedia').toLowerCase();
const STABILITY_API_KEY = String(process.env.STABILITY_API_KEY || '').trim();
const UNSPLASH_ACCESS_KEY = String(process.env.UNSPLASH_ACCESS_KEY || '').trim();
const UNSPLASH_STOP_WORDS = new Set(['a','an','the','and','or','with','without','for','of','to','in','on','at','from','by','is','are','be','this','that','these','those','into','onto','over','under','very','some','any','about','around','your','our','their','my','its','his','her','as','than','then','but','so','such','more','most','less','few','many','much','into','through','during','while','before','after','during']);
const ABSTRACT_HINT_WORDS = new Set(['idea', 'concept', 'quality', 'state', 'emotion', 'feeling', 'mood', 'belief', 'virtue', 'value', 'attitude', 'behavior', 'condition', 'experience', 'trait', 'characteristic', 'principle', 'thought', 'process', 'relationship']);
const WEB_IMAGE_CACHE = new Map();
const GENERIC_IMAGE_HOST_MARKERS = ['picsum.photos', 'loremflickr.com', 'source.unsplash.com', 'image.pollinations.ai'];
const ABSTRACT_SCENE_HINTS = [
  {
    keywords: ['honest', 'honesty', 'truthful', 'truth'],
    scene: 'a student returning a lost wallet to another person, appreciative facial expressions, clear act of honesty',
  },
  {
    keywords: ['kind', 'kindness', 'benevolent', 'generous', 'helpful', 'compassion'],
    scene: 'a student helping a classmate pick up dropped books, warm supportive expressions, clear act of kindness',
  },
  {
    keywords: ['courage', 'brave', 'bravery', 'fearless'],
    scene: 'a person speaking confidently in front of a class while nervous, determined posture, clear act of courage',
  },
  {
    keywords: ['anxiety', 'anxious', 'worry', 'worried', 'stress', 'stressed'],
    scene: 'a student sitting at a desk with tense posture before an exam, worried expression, visual cues of anxiety',
  },
  {
    keywords: ['freedom', 'liberty', 'independence'],
    scene: 'a person stepping through an open gate into a bright open park, body language showing relief and freedom',
  },
  {
    keywords: ['hope', 'optimism', 'optimistic'],
    scene: 'a student looking toward a sunrise with a study notebook, calm positive expression, clear feeling of hope',
  },
  {
    keywords: ['respect', 'respectful', 'courteous'],
    scene: 'students listening attentively while one person speaks, polite body language, clear sign of respect',
  },
  {
    keywords: ['resilient', 'resilience', 'recover', 'adapt'],
    scene: 'a bent tree branch springing back after wind, nearby student continuing work after a setback, clear resilience metaphor',
  },
  {
    keywords: ['serendipity', 'chance', 'fortunate', 'fortunate discovery'],
    scene: 'a student finding an important dropped note by chance, surprised and happy expression, clear lucky discovery moment',
  },
  {
    keywords: ['ambiguous', 'vague', 'unclear'],
    scene: 'a crossroads sign with conflicting arrows while a student looks uncertain, clear visual of multiple interpretations',
  },
  {
    keywords: ['nostalgia', 'nostalgic'],
    scene: 'a person smiling while holding an old photo and remembering earlier school days, clear feeling of nostalgia',
  },
];
const GENERATED_IMAGE_DIR = path.join(__dirname, '..', '..', 'public', 'generated');

function canManageWords(role) {
  return role === 'creator' || role === 'admin';
}

function getDevScopedWords(context) {
  if (GLOBAL_WORD_SCOPE) {
    const store = devStore.readStore();
    return store.words.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return context.role === 'student'
    ? devStore.getWordsByUserIds(context.sourceUserIds)
    : devStore.getWordsByUser(context.sourceUserId);
}

function buildDbWordQuery(context) {
  if (GLOBAL_WORD_SCOPE) return {};
  return context.role === 'student'
    ? { userId: { $in: context.sourceUserIds } }
    : { userId: context.sourceUserId };
}

function safeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePartOfSpeech(value) {
  const raw = safeText(value).toLowerCase();
  const map = {
    noun: 'noun',
    verb: 'verb',
    adjective: 'adjective',
    adverb: 'adverb',
    phrase: 'phrase',
    idiom: 'idiom',
    other: 'other',
    n: 'noun',
    v: 'verb',
    adj: 'adjective',
    adv: 'adverb',
  };
  return map[raw] || 'other';
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => safeText(tag))
      .filter(Boolean)
      .slice(0, 12);
  }
  const one = safeText(tags);
  return one ? [one] : [];
}

function normalizeDomain(value) {
  const raw = safeText(value).toLowerCase();
  return raw || 'general';
}

function normalizeDifficulty(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(5, Math.max(1, Math.round(numeric))) : 3;
}

function normalizeTargetBand(value) {
  const raw = safeText(value);
  const allowed = new Set(['400-500', '500-600', '600-700', '700+']);
  return allowed.has(raw) ? raw : '500-600';
}

function normalizeStatus(value) {
  const raw = safeText(value).toLowerCase();
  const allowed = new Set(['locked', 'in_progress', 'mastered']);
  return allowed.has(raw) ? raw : 'locked';
}

function normalizeTargetScoreRange(value) {
  return normalizeTargetBand(value);
}

function normalizeLearningStatus(value) {
  return normalizeStatus(value);
}

function normalizeDeckId(value) {
  const raw = safeText(value);
  return raw || null;
}

function resolveScopedDomain({ domain, deckId, existingDomain } = {}) {
  const normalizedDeckId = normalizeDeckId(deckId);
  if (normalizedDeckId) return 'deck';
  const candidate = normalizeDomain(domain !== undefined ? domain : existingDomain);
  return candidate === 'deck' ? 'general' : candidate;
}

function buildWordRecord(raw) {
  if (typeof raw === 'string') {
    return {
      word: safeText(raw),
      definition: '',
      partOfSpeech: 'other',
      example: '',
      notes: '',
      difficulty: 3,
      domain: 'general',
      targetScoreRange: '500-600',
      learningStatus: 'locked',
      tags: [],
      language: 'en',
      imageUrl: '',
    };
  }

  const source = raw && typeof raw === 'object' ? raw : {};
  const word = safeText(source.word || source.term);
  const definition = safeText(source.definition || source.def);

  return {
    word,
    definition,
    language: safeText(source.language || 'en').toLowerCase() || 'en',
    partOfSpeech: normalizePartOfSpeech(source.partOfSpeech || source.pos),
    example: safeText(source.example || source.ex),
    notes: safeText(source.notes),
    difficulty: normalizeDifficulty(source.difficulty),
    domain: normalizeDomain(source.domain || source.category || source.topic),
    targetScoreRange: normalizeTargetScoreRange(source.targetScoreRange || source.targetBand || source.scoreRange),
    learningStatus: normalizeLearningStatus(source.learningStatus || source.status),
    tags: normalizeTags(source.tags),
    deckId: normalizeDeckId(source.deckId),
    imageUrl: safeText(source.imageUrl || source.image),
  };
}

function ensureCompleteWordMetadata(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const word = safeText(source.word || source.term);
  const definition = safeText(source.definition || source.def) || `The word "${word || 'this vocabulary item'}" is used in everyday English to express a specific idea, action, or feeling.`;
  const example = safeText(source.example || source.ex) || `In class, students used the word "${word || 'this vocabulary item'}" in a sentence so its meaning became clearer.`;

  return {
    ...source,
    word,
    definition: definition.slice(0, 600),
    example: example.slice(0, 400),
    partOfSpeech: normalizePartOfSpeech(source.partOfSpeech || source.pos),
  };
}

function withAdaptiveMetadataDefaults(raw) {
  const source = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
  return {
    ...source,
    difficulty: normalizeDifficulty(source.difficulty),
    domain: normalizeDomain(source.domain),
    targetScoreRange: normalizeTargetScoreRange(source.targetScoreRange),
    learningStatus: normalizeLearningStatus(source.learningStatus),
    adaptiveMetrics: source.adaptiveMetrics || {
      attempts: 0,
      correct: 0,
      incorrect: 0,
      consecutiveCorrectAcrossSessions: 0,
      averageLatencyMs: 0,
      lastLatencyMs: 0,
      abilityDelta: 0,
      dueAt: null,
      masteredAt: null,
      lastAttemptAt: null,
    },
  };
}

function dedupeKey(word, definition) {
  return `${safeText(word).toLowerCase()}::${safeText(definition).toLowerCase()}`;
}

function dedupeWordKey(word) {
  return safeText(word).toLowerCase();
}

async function fetchDefinitionFromDictionary(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const response = await axios.get(url, { timeout: 8000 });
  const entries = Array.isArray(response.data) ? response.data : [];

  for (const entry of entries) {
    const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
    for (const meaning of meanings) {
      const defs = Array.isArray(meaning.definitions) ? meaning.definitions : [];
      const firstDef = defs.find((item) => safeText(item && item.definition));
      if (!firstDef) continue;

      return {
        definition: safeText(firstDef.definition),
        example: safeText(firstDef.example),
        partOfSpeech: normalizePartOfSpeech(meaning.partOfSpeech),
      };
    }
  }

  return null;
}

async function enrichMissingDefinition(entry) {
  if (safeText(entry.definition)) return { ...entry, autoGenerated: false };

  try {
    const fromDictionary = await fetchDefinitionFromDictionary(entry.word);
    if (fromDictionary && fromDictionary.definition) {
      return {
        ...entry,
        definition: fromDictionary.definition,
        example: entry.example || fromDictionary.example || '',
        partOfSpeech: entry.partOfSpeech === 'other' ? fromDictionary.partOfSpeech : entry.partOfSpeech,
        tags: Array.from(new Set([...(entry.tags || []), 'auto-definition'])),
        autoGenerated: true,
      };
    }
  } catch (err) {
    // Fall through to local fallback definition.
  }

  return {
    ...entry,
    definition: `Definition pending for "${entry.word}".`,
    tags: Array.from(new Set([...(entry.tags || []), 'auto-definition-pending'])),
    autoGenerated: true,
  };
}

async function fetchImageFromWikipedia(word) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
  const response = await axios.get(url, {
    timeout: 7000,
    headers: { Accept: 'application/json' },
  });
  const data = response && response.data ? response.data : null;
  if (!data) return '';

  const thumb = data.thumbnail && data.thumbnail.source ? String(data.thumbnail.source).trim() : '';
  if (thumb && /^https?:\/\//i.test(thumb)) return thumb;

  const original = data.originalimage && data.originalimage.source ? String(data.originalimage.source).trim() : '';
  if (original && /^https?:\/\//i.test(original)) return original;

  return '';
}

async function searchWikipediaTitles(query, limit = 3) {
  const q = safeText(query);
  if (!q) return [];

  const response = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 8000,
    params: {
      action: 'query',
      list: 'search',
      srsearch: q,
      srlimit: Math.max(1, Math.min(limit, 8)),
      format: 'json',
    },
    headers: { Accept: 'application/json' },
  });

  const results = Array.isArray(response && response.data && response.data.query && response.data.query.search)
    ? response.data.query.search
    : [];

  return results
    .map((item) => safeText(item && item.title))
    .filter(Boolean)
    .slice(0, limit);
}

async function fetchImageFromWikipediaBySearch(query) {
  const titles = await searchWikipediaTitles(query, 3);
  for (const title of titles) {
    try {
      const imageUrl = await fetchImageFromWikipedia(title);
      if (imageUrl) return imageUrl;
    } catch (err) {
      // Try next title.
    }
  }
  return '';
}

function buildStabilityPrompt(word, definition = '', partOfSpeech = '') {
  const cleanWord = safeText(word);
  const cleanDefinition = safeText(definition);
  const cleanPartOfSpeech = safeText(partOfSpeech);
  const abstract = isLikelyAbstractWord(cleanWord, cleanDefinition, cleanPartOfSpeech);

  return [
    abstract
      ? `Create a clear educational image that represents the vocabulary concept "${cleanWord}" in a relatable everyday situation.`
      : `Create a clear educational vocabulary image for the word "${cleanWord}".`,
    cleanDefinition ? `Meaning: ${cleanDefinition}.` : '',
    cleanPartOfSpeech ? `Part of speech: ${cleanPartOfSpeech}.` : '',
    abstract
      ? 'Use people, facial expression, body language, or a simple scene to make the meaning obvious to a student.'
      : 'Show one obvious central subject or scene that helps a student understand the word.',
    abstract
      ? 'Prefer a clean, relatable classroom-friendly illustration with clear context clues rather than decorative art.'
      : 'Use a clean classroom-friendly illustration or realistic style.',
    'No text, no labels, no watermark, and no collage.',
    'Keep the background simple and focused on the meaning of the word.',
  ].filter(Boolean).join(' ');
}

function buildPollinationsPrompt(word, definition = '', partOfSpeech = '') {
  const cleanWord = safeText(word);
  const cleanDefinition = safeText(definition);
  const cleanPartOfSpeech = safeText(partOfSpeech);
  const abstract = isLikelyAbstractWord(cleanWord, cleanDefinition, cleanPartOfSpeech);
  const abstractSceneHint = abstract ? pickAbstractSceneHint(cleanWord, cleanDefinition) : '';
  const concreteAnchor = !abstract ? buildConcreteAnchor(cleanWord, cleanDefinition) : '';

  return [
    abstract
      ? `relatable educational illustration for the vocabulary concept ${cleanWord}`
      : `educational vocabulary image for ${cleanWord}`,
    cleanDefinition ? `meaning ${cleanDefinition}` : '',
    cleanPartOfSpeech ? `part of speech ${cleanPartOfSpeech}` : '',
    abstract
      ? `everyday classroom scene, expressive people, clear context clues, ${abstractSceneHint || 'show cause and effect behavior that clearly expresses this concept'}`
      : `clear central subject, easy for students to recognize, ${concreteAnchor || `focus tightly on ${cleanWord}`}`,
    abstract ? 'avoid surreal patterns and decorative textures; make the scene literal and explainable' : 'avoid abstract textures; make the object identity obvious',
    'simple background',
    'classroom friendly',
    'no text',
    'no watermark'
  ].filter(Boolean).join(', ');
}

function pickAbstractSceneHint(word, definition = '') {
  const joined = `${safeText(word)} ${safeText(definition)}`.toLowerCase();

  for (const rule of ABSTRACT_SCENE_HINTS) {
    if (rule.keywords.some((keyword) => joined.includes(keyword))) {
      return rule.scene;
    }
  }

  const keywords = tokenize(definition).filter((token) => !ABSTRACT_HINT_WORDS.has(token)).slice(0, 3);
  if (keywords.length) {
    return `show a student-centered scene that makes ${keywords.join(', ')} visually obvious`;
  }

  return 'show a simple cause-and-effect human interaction that clearly demonstrates this concept';
}

function buildConcreteAnchor(word, definition = '') {
  const wordToken = safeText(word).toLowerCase();
  const definitionTokens = tokenize(definition)
    .filter((token) => token.length > 2)
    .filter((token) => !ABSTRACT_HINT_WORDS.has(token))
    .filter((token) => token !== wordToken)
    .slice(0, 4);

  if (!definitionTokens.length) return '';
  return `include visual details for ${definitionTokens.join(', ')}`;
}

function buildPollinationsImageUrl(word, definition = '', partOfSpeech = '', options = {}) {
  const prompt = buildPollinationsPrompt(word, definition, partOfSpeech);
  const params = new URLSearchParams({
    width: String(options.width || 900),
    height: String(options.height || 560),
    nologo: 'true',
    model: 'flux',
  });

  if (options.seed) {
    params.set('seed', String(options.seed));
  }

  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

function isLikelyAbstractWord(word, definition = '', partOfSpeech = '') {
  const definitionTokens = tokenize(definition);
  const wordValue = safeText(word).toLowerCase();
  const pos = safeText(partOfSpeech).toLowerCase();

  if (pos === 'adjective' || pos === 'adverb') return true;

  if (definitionTokens.some((token) => ABSTRACT_HINT_WORDS.has(token))) {
    return true;
  }

  if (definitionTokens.some((token) => ['someone', 'something', 'somebody'].includes(token))) {
    return true;
  }

  return ['honesty', 'kindness', 'courage', 'anxiety', 'freedom', 'hope', 'fear', 'respect'].includes(wordValue);
}

function isGeneratedImageUrl(imageUrl) {
  const value = safeText(imageUrl);
  return value.startsWith('/generated/');
}

function isPollinationsImageUrl(imageUrl) {
  const value = safeText(imageUrl);
  return value.startsWith('https://image.pollinations.ai/prompt/');
}

function shouldUsePollinationsDisplayImage(word) {
  if (!word) return false;

  const imageUrl = safeText(word.imageUrl);
  if (!imageUrl) return true;

  return !isPollinationsImageUrl(imageUrl) && !isGeneratedImageUrl(imageUrl);
}

function shouldReuseExistingImage(entry, forceRegenerate = false) {
  if (forceRegenerate) return false;
  return isGeneratedImageUrl(entry && entry.imageUrl) || isPollinationsImageUrl(entry && entry.imageUrl);
}

async function generateImageWithStability(word, definition = '', partOfSpeech = '') {
  if (!STABILITY_API_KEY) return null;

  const prompt = buildStabilityPrompt(word, definition, partOfSpeech);
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('aspect_ratio', '1:1');
  form.append('output_format', 'png');

  const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STABILITY_API_KEY}`,
      Accept: 'image/*',
    },
    body: form,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Stability API request failed: ${response.status} ${message}`.trim());
  }

  const fileSafeWord = safeText(word).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'word';
  const fileName = `${fileSafeWord}-${Date.now()}.png`;
  const outputPath = path.join(GENERATED_IMAGE_DIR, fileName);
  const imageBuffer = Buffer.from(await response.arrayBuffer());

  await fs.mkdir(GENERATED_IMAGE_DIR, { recursive: true });
  await fs.writeFile(outputPath, imageBuffer);

  return `/generated/${fileName}`;
}

function buildUnsplashSearchQueries(word, definition = '', partOfSpeech = '') {
  const baseWord = safeText(word).toLowerCase();
  if (!baseWord) return [];

  const definitionKeywords = safeText(definition)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !UNSPLASH_STOP_WORDS.has(token))
    .filter((token) => token !== baseWord);

  const uniqueKeywords = Array.from(new Set(definitionKeywords)).slice(0, 6);
  const queries = new Set([baseWord]);

  if (uniqueKeywords.length) {
    for (const keyword of uniqueKeywords) {
      queries.add(`${baseWord} ${keyword}`);
    }
    if (uniqueKeywords.length > 1) {
      queries.add(`${baseWord} ${uniqueKeywords.slice(0, 2).join(' ')}`);
    }
  }

  if (partOfSpeech) {
    queries.add(`${baseWord} ${safeText(partOfSpeech).toLowerCase()}`);
  }

  queries.add(`${baseWord} object`);
  queries.add(`${baseWord} concept`);

  return Array.from(queries).filter(Boolean).slice(0, 8);
}

function tokenize(text) {
  return safeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreUnsplashResult(word, definition = '', result = {}) {
  const baseWord = safeText(word).toLowerCase();
  const descriptionText = [result.alt_description, result.description, result.title].join(' ');
  const candidateText = `${baseWord} ${safeText(definition)} ${descriptionText}`;
  const tokens = tokenize(candidateText);
  const meaningfulTokens = tokens.filter((token) => token.length > 2 && !UNSPLASH_STOP_WORDS.has(token));
  const wordTokens = tokenize(baseWord);
  const definitionTokens = tokenize(definition);
  const resultTokens = tokenize(descriptionText);

  let score = 0;

  for (const token of wordTokens) {
    if (resultTokens.includes(token)) score += 4;
  }

  for (const token of definitionTokens) {
    if (resultTokens.includes(token)) score += 2;
  }

  if (resultTokens.some((token) => token === baseWord)) score += 6;
  if (resultTokens.some((token) => token.includes(baseWord))) score += 2;
  if (resultTokens.some((token) => definitionTokens.includes(token))) score += 3;

  const overlap = meaningfulTokens.filter((token) => resultTokens.includes(token));
  score += overlap.length;

  return score;
}

async function fetchImageFromUnsplash(word, definition = '', partOfSpeech = '') {
  if (!UNSPLASH_ACCESS_KEY) return null;

  const queries = buildUnsplashSearchQueries(word, definition, partOfSpeech);
  if (!queries.length) return null;

  const endpoint = 'https://api.unsplash.com/search/photos';

  for (const query of queries) {
    try {
      const response = await axios.get(endpoint, {
        timeout: 9000,
        params: {
          query,
          per_page: 1,
          orientation: 'landscape',
          content_filter: 'high',
        },
        headers: {
          Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
          'Accept-Version': 'v1',
        },
      });

      const results = Array.isArray(response.data && response.data.results)
        ? response.data.results
        : [];
      if (!results.length) continue;

      const scoredResults = results
        .map((result) => ({
          result,
          score: scoreUnsplashResult(word, definition, result),
        }))
        .sort((a, b) => b.score - a.score);

      const best = scoredResults[0];
      if (!best || !best.result) continue;

      const url = safeText(best.result.urls && (best.result.urls.regular || best.result.urls.small || best.result.urls.thumb));
      if (!url) continue;

      const photographer = safeText(best.result.user && best.result.user.name);
      const profileLink = safeText(best.result.user && best.result.user.links && best.result.user.links.html);
      const credit = photographer
        ? `Photo by ${photographer}${profileLink ? ` (${profileLink})` : ''}`
        : '';

      return { url, credit };
    } catch (err) {
      // Try the next query.
    }
  }

  return null;
}

function attachNote(base, extra) {
  const origin = safeText(base);
  const note = safeText(extra);
  if (!note) return origin;
  if (!origin) return note;
  if (origin.toLowerCase().includes(note.toLowerCase())) return origin;
  return `${origin} | ${note}`;
}

function buildFallbackImageUrl(word, definition = '') {
  const tokens = [safeText(word), ...extractMeaningKeywords(definition, 2)]
    .map((token) => String(token || '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
    .slice(0, 3);
  const tags = tokens.length ? tokens.join(',') : 'vocabulary';
  return `https://loremflickr.com/900/560/${tags}`;
}

function isGenericFallbackImageUrl(imageUrl) {
  const value = safeText(imageUrl).toLowerCase();
  if (!value) return false;
  return GENERIC_IMAGE_HOST_MARKERS.some((marker) => value.includes(marker));
}

function extractMeaningKeywords(definition = '', max = 4) {
  const unique = Array.from(new Set(tokenize(definition)
    .filter((token) => token.length > 2)
    .filter((token) => !UNSPLASH_STOP_WORDS.has(token))
    .filter((token) => !ABSTRACT_HINT_WORDS.has(token))));

  const head = unique.slice(0, 2);
  const tail = unique.slice(-2);
  const prioritized = Array.from(new Set([
    ...tail,
    ...head,
    ...unique.filter((token) => token.length >= 7),
  ]));

  return prioritized.slice(0, max);
}

function buildMeaningWebQueries(word, definition = '', partOfSpeech = '') {
  const cleanWord = safeText(word);
  const cleanDefinition = safeText(definition);
  const pos = safeText(partOfSpeech);
  const queries = [];
  const abstract = isLikelyAbstractWord(cleanWord, cleanDefinition, pos);
  const meaningKeywords = extractMeaningKeywords(cleanDefinition, 4);

  if (abstract) {
    const sceneHint = pickAbstractSceneHint(cleanWord, cleanDefinition);
    if (sceneHint) {
      queries.push(sceneHint);
      queries.push(`${cleanWord} ${sceneHint}`);
    }
    queries.push(`${cleanWord} human interaction`);
    queries.push(`${cleanWord} emotion scene`);
  } else {
    const concreteAnchor = buildConcreteAnchor(cleanWord, cleanDefinition);
    if (concreteAnchor) queries.push(`${cleanWord} ${concreteAnchor}`);
    queries.push(`${cleanWord} object photo`);
  }

  if (meaningKeywords.length) {
    queries.push(`${cleanWord} ${meaningKeywords.join(' ')}`);
    queries.push(`${cleanWord} ${meaningKeywords.slice(-2).join(' ')}`);
    queries.push(meaningKeywords.join(' '));
  }

  if (pos) queries.push(`${cleanWord} ${pos}`);
  queries.push(cleanWord);

  return Array.from(new Set(queries.map((q) => safeText(q)).filter(Boolean))).slice(0, 7);
}

function buildWordVariants(word) {
  const base = safeText(word).toLowerCase();
  if (!base) return [];

  const variants = [base];
  if (base.endsWith('ent') && base.length > 4) {
    variants.push(`${base.slice(0, -3)}ence`);
  }
  if (base.endsWith('ant') && base.length > 4) {
    variants.push(`${base.slice(0, -3)}ance`);
  }
  if (base.endsWith('ous') && base.length > 4) {
    variants.push(`${base.slice(0, -3)}osity`);
  }

  return Array.from(new Set(variants));
}

function scoreWikimediaCandidate(query, page = {}) {
  const title = safeText(page.title).toLowerCase();
  const titleTokens = tokenize(title);
  const queryTokens = tokenize(query).filter((token) => token.length > 2 && !UNSPLASH_STOP_WORDS.has(token));

  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.includes(token)) score += 3;
    if (title.includes(token)) score += 1;
  }

  if (title.includes('icon') || title.includes('logo') || title.includes('symbol')) score -= 2;
  if (title.includes('diagram') || title.includes('chart')) score -= 1;

  return score;
}

async function fetchImageFromWikimediaCommons(query) {
  const q = safeText(query);
  if (!q) return '';

  const params = {
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: 6,
    gsrlimit: 8,
    gsrsearch: `filetype:bitmap ${q}`,
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: 1200,
    iiurlheight: 800,
  };

  const response = await axios.get('https://commons.wikimedia.org/w/api.php', {
    timeout: 9000,
    params,
    headers: { Accept: 'application/json' },
  });

  const pages = response && response.data && response.data.query && response.data.query.pages
    ? Object.values(response.data.query.pages)
    : [];

  const scored = pages
    .map((page) => {
      const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
      const url = safeText((info && (info.thumburl || info.url)) || '');
      return {
        url,
        score: scoreWikimediaCandidate(q, page),
      };
    })
    .filter((item) => /^https?:\/\//i.test(item.url))
    .filter((item) => /\.(jpg|jpeg|png|webp)(\?|$)/i.test(item.url))
    .sort((a, b) => b.score - a.score);

  return scored[0] ? scored[0].url : '';
}

async function fetchMeaningAwareWebImage(word, definition = '', partOfSpeech = '') {
  const cacheKey = dedupeKey(word, definition);
  if (WEB_IMAGE_CACHE.has(cacheKey)) return WEB_IMAGE_CACHE.get(cacheKey);

  const queries = buildMeaningWebQueries(word, definition, partOfSpeech);
  const variants = buildWordVariants(word);
  const keywords = extractMeaningKeywords(definition, 4);

  for (const query of queries) {
    try {
      const commonsImage = await fetchImageFromWikimediaCommons(query);
      if (commonsImage) {
        WEB_IMAGE_CACHE.set(cacheKey, commonsImage);
        return commonsImage;
      }
    } catch (err) {
      // Try next query.
    }
  }

  for (const variant of variants) {
    try {
      const commonsVariant = await fetchImageFromWikimediaCommons(variant);
      if (commonsVariant) {
        WEB_IMAGE_CACHE.set(cacheKey, commonsVariant);
        return commonsVariant;
      }
    } catch (err) {
      // Continue.
    }
  }

  for (const keyword of keywords) {
    try {
      const commonsKeyword = await fetchImageFromWikimediaCommons(keyword);
      if (commonsKeyword) {
        WEB_IMAGE_CACHE.set(cacheKey, commonsKeyword);
        return commonsKeyword;
      }
    } catch (err) {
      // Continue.
    }
  }

  try {
    const wikiWordImage = await fetchImageFromWikipedia(word);
    if (wikiWordImage) {
      WEB_IMAGE_CACHE.set(cacheKey, wikiWordImage);
      return wikiWordImage;
    }
  } catch (err) {
    // Continue.
  }

  for (const variant of variants) {
    try {
      const wikiVariantImage = await fetchImageFromWikipedia(variant);
      if (wikiVariantImage) {
        WEB_IMAGE_CACHE.set(cacheKey, wikiVariantImage);
        return wikiVariantImage;
      }
    } catch (err) {
      // Continue.
    }
  }

  for (const keyword of keywords) {
    try {
      const wikiKeywordImage = await fetchImageFromWikipedia(keyword);
      if (wikiKeywordImage) {
        WEB_IMAGE_CACHE.set(cacheKey, wikiKeywordImage);
        return wikiKeywordImage;
      }
    } catch (err) {
      // Try next keyword.
    }
  }

  for (const query of queries) {
    try {
      const wikiSearchImage = await fetchImageFromWikipediaBySearch(query);
      if (wikiSearchImage) {
        WEB_IMAGE_CACHE.set(cacheKey, wikiSearchImage);
        return wikiSearchImage;
      }
    } catch (err) {
      // Try next query.
    }
  }

  const fallback = buildFallbackImageUrl(word, definition);
  WEB_IMAGE_CACHE.set(cacheKey, fallback);
  return fallback;
}

async function enrichMissingImage(entry) {
  if (safeText(entry.imageUrl)) return { ...entry, imageAutoGenerated: false };

  if (IMAGE_PROVIDER === 'none') {
    return { ...entry, imageUrl: '', imageAutoGenerated: false };
  }

  if (IMAGE_PROVIDER === 'stability' && STABILITY_API_KEY) {
    try {
      const generatedUrl = await generateImageWithStability(entry.word, entry.definition, entry.partOfSpeech);
      if (generatedUrl) {
        return {
          ...entry,
          imageUrl: generatedUrl,
          tags: Array.from(new Set([...(entry.tags || []), 'auto-image', 'image-stability'])),
          imageAutoGenerated: true,
        };
      }
    } catch (err) {
      // Fallback chain continues.
    }
  }

  if (IMAGE_PROVIDER === 'unsplash' && UNSPLASH_ACCESS_KEY) {
    try {
      const unsplash = await fetchImageFromUnsplash(entry.word, entry.definition, entry.partOfSpeech);
      if (unsplash && unsplash.url) {
        return {
          ...entry,
          imageUrl: unsplash.url,
          notes: attachNote(entry.notes, unsplash.credit),
          tags: Array.from(new Set([...(entry.tags || []), 'auto-image', 'image-unsplash'])),
          imageAutoGenerated: true,
        };
      }
    } catch (err) {
      // Fallback chain continues.
    }
  }

  const webImage = await fetchMeaningAwareWebImage(entry.word, entry.definition, entry.partOfSpeech);
  if (webImage) {
    return {
      ...entry,
      imageUrl: webImage,
      tags: Array.from(new Set([...(entry.tags || []), 'auto-image', 'image-web'])),
      imageAutoGenerated: true,
    };
  }

  if (IMAGE_PROVIDER !== 'unsplash' && UNSPLASH_ACCESS_KEY) {
    try {
      const unsplash = await fetchImageFromUnsplash(entry.word, entry.definition, entry.partOfSpeech);
      if (unsplash && unsplash.url) {
        return {
          ...entry,
          imageUrl: unsplash.url,
          notes: attachNote(entry.notes, unsplash.credit),
          tags: Array.from(new Set([...(entry.tags || []), 'auto-image', 'image-unsplash'])),
          imageAutoGenerated: true,
        };
      }
    } catch (err) {
      // Final fallback below.
    }
  }

  return {
    ...entry,
    imageUrl: buildFallbackImageUrl(entry.word, entry.definition),
    tags: Array.from(new Set([...(entry.tags || []), 'auto-image'])),
    imageAutoGenerated: true,
  };
}

function canAccessWordFromContext(word, context) {
  if (!word || !context) return false;
  if (GLOBAL_WORD_SCOPE) return true;
  return Array.isArray(context.sourceUserIds) && context.sourceUserIds.some((id) => String(id) === String(word.userId));
}

async function generateAndPersistWordImage(existingWord, forceRegenerate = false) {
  if (IMAGE_PROVIDER === 'none') {
    throw new Error('Image generation is disabled.');
  }

  if (IMAGE_PROVIDER === 'pollinations') {
    if (shouldReuseExistingImage(existingWord, forceRegenerate)) {
      return {
        imageUrl: existingWord.imageUrl,
        reused: true,
      };
    }

    return {
      imageUrl: buildPollinationsImageUrl(
        existingWord.word,
        existingWord.definition,
        existingWord.partOfSpeech,
        forceRegenerate ? { seed: Date.now() } : {}
      ),
      reused: false,
    };
  }

  if (!STABILITY_API_KEY) {
    throw new Error('Stability image generation is not configured.');
  }

  if (shouldReuseExistingImage(existingWord, forceRegenerate)) {
    return {
      imageUrl: existingWord.imageUrl,
      reused: true,
    };
  }

  const imageUrl = await generateImageWithStability(existingWord.word, existingWord.definition, existingWord.partOfSpeech);
  return {
    imageUrl,
    reused: false,
  };
}

function resolveWordDisplayImage(word, options = {}) {
  if (!word) return word;

  const imageUrl = safeText(word.imageUrl);
  if (isGeneratedImageUrl(imageUrl)) return word;

  if (imageUrl) {
    return {
      ...word,
      imageUrl,
    };
  }

  if (options.allowRemote === false) {
    return {
      ...word,
      imageUrl: buildFallbackImageUrl(word.word, word.definition),
    };
  }

  return {
    ...word,
    imageUrl: buildFallbackImageUrl(word.word, word.definition),
  };
}

function withDisplayImage(word) {
  return resolveWordDisplayImage(word, { allowRemote: false });
}

async function withWebDisplayImage(word) {
  if (!word) return word;

  const imageUrl = safeText(word.imageUrl);
  if (isGeneratedImageUrl(imageUrl)) return word;

  if (imageUrl) {
    return {
      ...word,
      imageUrl,
    };
  }

  const webImage = await fetchMeaningAwareWebImage(word.word, word.definition, word.partOfSpeech);
  if (webImage) {
    return {
      ...word,
      imageUrl: webImage,
    };
  }

  return {
    ...word,
    imageUrl: buildFallbackImageUrl(word.word, word.definition),
  };
}

// All routes require authentication
router.use(auth);

async function getWordAccessContext(userId) {
  if (!isDbConnected()) {
    const user = devStore.findUserById(userId);
    if (!user) return null;
    const role = user.role || 'creator';
    if (GLOBAL_WORD_SCOPE) {
      return {
        user,
        role,
        sourceUserId: userId,
        sourceUserIds: [userId],
        canManageWords: canManageWords(role),
        hasCreatorContent: true,
      };
    }
    if (role === 'student') {
      const creatorIds = devStore
        .listUsers()
        .filter((entry) => (entry.role || 'student') === 'creator')
        .map((entry) => String(entry._id));
      if (creatorIds.length) {
        return {
          user,
          role,
          sourceUserId: creatorIds[0],
          sourceUserIds: creatorIds,
          canManageWords: false,
          hasCreatorContent: true,
        };
      }
      return {
        user,
        role,
        sourceUserId: null,
        sourceUserIds: [],
        canManageWords: false,
        hasCreatorContent: false,
      };
    }
    return { user, role: 'creator', sourceUserId: userId, sourceUserIds: [userId], canManageWords: true, hasCreatorContent: true };
  }

  const user = await User.findById(userId).select('role creatorCode linkedCreatorCode');
  if (!user) return null;
  const role = user.role || 'creator';
  if (GLOBAL_WORD_SCOPE) {
    return {
      user,
      role,
      sourceUserId: userId,
      sourceUserIds: [userId],
      canManageWords: canManageWords(role),
      hasCreatorContent: true,
    };
  }
  if (role === 'student') {
    const creatorRows = await User.find({ role: 'creator' }).select('_id').lean();
    const creatorIds = creatorRows.map((entry) => String(entry._id));
    if (creatorIds.length) {
      return {
        user,
        role,
        sourceUserId: creatorIds[0],
        sourceUserIds: creatorIds,
        canManageWords: false,
        hasCreatorContent: true,
      };
    }
    return {
      user,
      role,
      sourceUserId: null,
      sourceUserIds: [],
      canManageWords: false,
      hasCreatorContent: false,
    };
  }
  return { user, role: 'creator', sourceUserId: userId, sourceUserIds: [userId], canManageWords: true, hasCreatorContent: true };
}

// GET /api/words
router.get('/', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);
    const deckId = normalizeDeckId(req.query.deckId);
    const unassignedOnly = String(req.query.unassigned || '').toLowerCase() === 'true';
    const domainFilter = safeText(req.query.domain || '').toLowerCase();
    const targetScoreRangeFilter = safeText(req.query.targetScoreRange || '');
    const learningStatusFilter = safeText(req.query.learningStatus || '').toLowerCase();
    
    if (!isDbConnected()) {
      let words = getDevScopedWords(context);
      if (deckId) {
        words = words.filter((word) => String(word.deckId || '') === deckId);
      } else if (unassignedOnly) {
        words = words.filter((word) => !safeText(word.deckId));
        if (!domainFilter) {
          words = words.filter((word) => normalizeDomain(word.domain) !== 'deck');
        }
      }
      if (domainFilter) {
        words = words.filter((word) => normalizeDomain(word.domain) === normalizeDomain(domainFilter));
      }
      if (targetScoreRangeFilter) {
        words = words.filter((word) => normalizeTargetScoreRange(word.targetScoreRange) === normalizeTargetScoreRange(targetScoreRangeFilter));
      }
      if (learningStatusFilter) {
        words = words.filter((word) => normalizeLearningStatus(word.learningStatus) === normalizeLearningStatus(learningStatusFilter));
      }
      const paginated = await Promise.all(words.slice(skip, skip + limit).map((word) => withWebDisplayImage(withDisplayImage(withAdaptiveMetadataDefaults(word)))));
      return res.json({ words: paginated, total: words.length, limit, skip });
    }

    const query = buildDbWordQuery(context);
    if (deckId) {
      query.deckId = deckId;
    } else if (unassignedOnly) {
      query.$or = [{ deckId: null }, { deckId: { $exists: false } }];
      if (!domainFilter) {
        query.domain = { $ne: 'deck' };
      }
    }
    if (domainFilter) {
      query.domain = normalizeDomain(domainFilter);
    }
    if (targetScoreRangeFilter) {
      query.targetScoreRange = normalizeTargetScoreRange(targetScoreRangeFilter);
    }
    if (learningStatusFilter) {
      query.learningStatus = normalizeLearningStatus(learningStatusFilter);
    }
    
    const total = await Word.countDocuments(query);
    const words = await Word.find(query).sort({ createdAt: -1 }).limit(limit).skip(skip);
    const resolvedWords = await Promise.all(words.map((word) => withWebDisplayImage(withDisplayImage(withAdaptiveMetadataDefaults(word)))));
    res.json({ words: resolvedWords, total, limit, skip });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch words.' });
  }
});

// GET /api/words/stats
router.get('/stats', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!isDbConnected()) {
      const words = getDevScopedWords(context);
      const total = words.length;
      const avgDifficulty = total
        ? (words.reduce((sum, w) => sum + (w.difficulty || 0), 0) / total).toFixed(1)
        : 0;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const thisWeek = words.filter(w => new Date(w.createdAt) >= weekAgo).length;
      const mostDifficult = [...words].sort((a, b) => b.difficulty - a.difficulty).slice(0, 5);
      return res.json({ total, avgDifficulty, thisWeek, mostDifficult });
    }

    const dbQuery = buildDbWordQuery(context);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const stats = await Word.aggregate([
      { $match: dbQuery },
      {
        $facet: {
          total: [{ $count: 'count' }],
          avgDifficulty: [
            { $group: { _id: null, avg: { $avg: '$difficulty' } } },
          ],
          thisWeek: [
            { $match: { createdAt: { $gte: weekAgo } } },
            { $count: 'count' },
          ],
          mostDifficult: [
            { $sort: { difficulty: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]);

    const totalCount = stats[0].total[0]?.count || 0;
    const avgDif = stats[0].avgDifficulty[0]?.avg || 0;
    const thisWeekCount = stats[0].thisWeek[0]?.count || 0;
    const mostDifficult = stats[0].mostDifficult || [];

    res.json({
      total: totalCount,
      avgDifficulty: totalCount ? avgDif.toFixed(1) : 0,
      thisWeek: thisWeekCount,
      mostDifficult,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch stats.' });
  }
});

// GET /api/words/image/by-meaning
router.get('/image/by-meaning', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    const word = safeText(req.query.word);
    const definition = safeText(req.query.definition);
    const partOfSpeech = safeText(req.query.partOfSpeech);

    if (!word) {
      return res.status(400).json({ message: 'word is required.' });
    }

    const imageUrl = await fetchMeaningAwareWebImage(word, definition, partOfSpeech);
    return res.json({ imageUrl });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to resolve image.' });
  }
});

// POST /api/words
router.post('/', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Students cannot create words. Ask your creator to add them.' });
    }
    const { word, definition, partOfSpeech, example, notes, tags, difficulty, deckId, domain, targetScoreRange, learningStatus } = req.body;
    if (!word || !definition)
      return res.status(400).json({ message: 'Word and definition are required.' });

    const normalizedDeckId = normalizeDeckId(deckId);
    const scopedDomain = resolveScopedDomain({ domain, deckId: normalizedDeckId });

    if (!isDbConnected()) {
      const entry = devStore.createWord(context.sourceUserId, {
        word: word.trim(),
        definition,
        partOfSpeech: normalizePartOfSpeech(partOfSpeech || 'other'),
        example: example || '',
        notes: notes || '',
        tags: normalizeTags(tags || []),
        difficulty: Number.isFinite(Number(difficulty)) ? Math.min(5, Math.max(1, Math.round(Number(difficulty)))) : 3,
        domain: scopedDomain,
        targetScoreRange: normalizeTargetScoreRange(targetScoreRange),
        learningStatus: normalizeLearningStatus(learningStatus),
        deckId: normalizedDeckId,
      });
      return res.status(201).json({ word: withAdaptiveMetadataDefaults(entry) });
    }

    const entry = new Word({
      userId: context.sourceUserId,
      word: word.trim(),
      definition,
      partOfSpeech: normalizePartOfSpeech(partOfSpeech || 'other'),
      example: example || '',
      notes: notes || '',
      tags: normalizeTags(tags || []),
      difficulty: Number.isFinite(Number(difficulty)) ? Math.min(5, Math.max(1, Math.round(Number(difficulty)))) : 3,
      domain: scopedDomain,
      targetScoreRange: normalizeTargetScoreRange(targetScoreRange),
      learningStatus: normalizeLearningStatus(learningStatus),
      deckId: normalizedDeckId,
    });
    await entry.save();
    res.status(201).json({ word: withAdaptiveMetadataDefaults(entry) });
  } catch (err) {
    console.error('POST /api/words failed:', err);
    res.status(500).json({ message: 'Failed to save word.' });
  }
});

// PUT /api/words/:id
router.put('/:id', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Students cannot edit words.' });
    }
    if (!isDbConnected()) {
      const { word: w, definition, partOfSpeech, example, notes, tags, difficulty, deckId, domain, targetScoreRange, learningStatus } = req.body;
      const normalizedDeckId = deckId !== undefined ? normalizeDeckId(deckId) : undefined;
      const scopedDomain = (deckId !== undefined || domain !== undefined)
        ? resolveScopedDomain({ domain, deckId: normalizedDeckId })
        : undefined;
      const updated = GLOBAL_WORD_SCOPE
        ? devStore.updateWordGlobal(req.params.id, {
          ...(w ? { word: w.trim() } : {}),
          ...(definition ? { definition } : {}),
          ...(partOfSpeech ? { partOfSpeech: normalizePartOfSpeech(partOfSpeech) } : {}),
          ...(example !== undefined ? { example } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(tags ? { tags: normalizeTags(tags) } : {}),
          ...(difficulty !== undefined ? { difficulty: Number.isFinite(Number(difficulty)) ? Math.min(5, Math.max(1, Math.round(Number(difficulty)))) : 3 } : {}),
          ...(scopedDomain !== undefined ? { domain: scopedDomain } : {}),
          ...(targetScoreRange !== undefined ? { targetScoreRange: normalizeTargetScoreRange(targetScoreRange) } : {}),
          ...(learningStatus !== undefined ? { learningStatus: normalizeLearningStatus(learningStatus) } : {}),
          ...(deckId !== undefined ? { deckId: normalizedDeckId } : {}),
        })
        : devStore.updateWord(req.params.id, context.sourceUserId, {
        ...(w ? { word: w.trim() } : {}),
        ...(definition ? { definition } : {}),
        ...(partOfSpeech ? { partOfSpeech: normalizePartOfSpeech(partOfSpeech) } : {}),
        ...(example !== undefined ? { example } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(tags ? { tags: normalizeTags(tags) } : {}),
        ...(difficulty !== undefined ? { difficulty: Number.isFinite(Number(difficulty)) ? Math.min(5, Math.max(1, Math.round(Number(difficulty)))) : 3 } : {}),
        ...(scopedDomain !== undefined ? { domain: scopedDomain } : {}),
        ...(targetScoreRange !== undefined ? { targetScoreRange: normalizeTargetScoreRange(targetScoreRange) } : {}),
        ...(learningStatus !== undefined ? { learningStatus: normalizeLearningStatus(learningStatus) } : {}),
        ...(deckId !== undefined ? { deckId: normalizedDeckId } : {}),
      });
      if (!updated) return res.status(404).json({ message: 'Word not found.' });
      return res.json({ word: withAdaptiveMetadataDefaults(updated) });
    }

    const word = GLOBAL_WORD_SCOPE
      ? await Word.findById(req.params.id)
      : await Word.findOne({ _id: req.params.id, userId: context.sourceUserId });
    if (!word) return res.status(404).json({ message: 'Word not found.' });

    const { word: w, definition, partOfSpeech, example, notes, tags, difficulty, deckId, domain, targetScoreRange, learningStatus } = req.body;
    if (w) word.word = w.trim();
    if (definition) word.definition = definition;
    if (partOfSpeech) word.partOfSpeech = normalizePartOfSpeech(partOfSpeech);
    if (example !== undefined) word.example = example;
    if (notes !== undefined) word.notes = notes;
    if (tags) word.tags = normalizeTags(tags);
    if (difficulty !== undefined) word.difficulty = Number.isFinite(Number(difficulty)) ? Math.min(5, Math.max(1, Math.round(Number(difficulty)))) : 3;
    if (targetScoreRange !== undefined) word.targetScoreRange = normalizeTargetScoreRange(targetScoreRange);
    if (learningStatus !== undefined) word.learningStatus = normalizeLearningStatus(learningStatus);
    if (deckId !== undefined) word.deckId = normalizeDeckId(deckId);
    if (deckId !== undefined || domain !== undefined) {
      word.domain = resolveScopedDomain({
        domain,
        deckId: deckId !== undefined ? word.deckId : undefined,
        existingDomain: word.domain,
      });
    }

    await word.save();
    res.json({ word: withAdaptiveMetadataDefaults(word) });
  } catch (err) {
    console.error('PUT /api/words/:id failed:', err);
    res.status(500).json({ message: 'Failed to update word.' });
  }
});

// DELETE /api/words/:id
router.delete('/:id', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Students cannot delete words.' });
    }
    if (!isDbConnected()) {
      const ok = GLOBAL_WORD_SCOPE
        ? devStore.deleteWordGlobal(req.params.id)
        : devStore.deleteWord(req.params.id, context.sourceUserId);
      if (!ok) return res.status(404).json({ message: 'Word not found.' });
      return res.json({ message: 'Word deleted.' });
    }

    const word = GLOBAL_WORD_SCOPE
      ? await Word.findByIdAndDelete(req.params.id)
      : await Word.findOneAndDelete({ _id: req.params.id, userId: context.sourceUserId });
    if (!word) return res.status(404).json({ message: 'Word not found.' });
    res.json({ message: 'Word deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete word.' });
  }
});

// POST /api/words/:id/reviewed
router.post('/:id/reviewed', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    const { correct } = req.body;

    if (!isDbConnected()) {
      const word = GLOBAL_WORD_SCOPE
        ? devStore.findWordById(req.params.id)
        : devStore.findWordByIdForUser(req.params.id, context.sourceUserId);
      if (!word) return res.status(404).json({ message: 'Word not found.' });
      word.timesReviewed += 1;
      if (correct) word.timesCorrect += 1;
      word.lastReviewedAt = new Date().toISOString();
      const intervalDays = correct ? Math.min(30, Math.max(1, Math.round((word.timesReviewed || 1) * 2 + (word.difficulty || 3)))) : 1;
      word.nextReviewAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000).toISOString();
      if (GLOBAL_WORD_SCOPE) {
        devStore.updateWordGlobal(req.params.id, {
          timesReviewed: word.timesReviewed,
          timesCorrect: word.timesCorrect,
          lastReviewedAt: word.lastReviewedAt,
          nextReviewAt: word.nextReviewAt,
        });
      } else {
        devStore.updateWord(req.params.id, context.sourceUserId, {
          timesReviewed: word.timesReviewed,
          timesCorrect: word.timesCorrect,
          lastReviewedAt: word.lastReviewedAt,
          nextReviewAt: word.nextReviewAt,
        });
      }
      return res.json({ word });
    }

    const word = GLOBAL_WORD_SCOPE
      ? await Word.findById(req.params.id)
      : await Word.findOne({ _id: req.params.id, userId: { $in: context.sourceUserIds } });
    if (!word) return res.status(404).json({ message: 'Word not found.' });
    word.timesReviewed += 1;
    if (correct) word.timesCorrect += 1;
    word.lastReviewedAt = new Date();
    const intervalDays = correct ? Math.min(30, Math.max(1, Math.round((word.timesReviewed || 1) * 2 + (word.difficulty || 3)))) : 1;
    word.nextReviewAt = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);
    await word.save();
    res.json({ word });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update review stats.' });
  }
});

// POST /api/words/:id/regenerate-image
router.post('/:id/regenerate-image', async (req, res) => {
  try {
    const forceRegenerate = true;

    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    if (!isDbConnected()) {
      const existing = devStore.findWordById(req.params.id);
      if (!canAccessWordFromContext(existing, context)) {
        return res.status(404).json({ message: 'Word not found.' });
      }

      const generated = await generateAndPersistWordImage(existing, forceRegenerate);
      const imageUrl = generated.imageUrl;
      const updated = GLOBAL_WORD_SCOPE
        ? devStore.updateWordGlobal(req.params.id, { imageUrl })
        : devStore.updateWord(req.params.id, existing.userId, { imageUrl });

      return res.json({
        imageUrl,
        word: updated,
        provider: 'stability',
      });
    }

    const existing = await Word.findById(req.params.id);
    if (!existing || !canAccessWordFromContext(existing, context)) {
      return res.status(404).json({ message: 'Word not found.' });
    }

    const generated = await generateAndPersistWordImage(existing, forceRegenerate);
    const imageUrl = generated.imageUrl;
    existing.imageUrl = imageUrl;
    existing.updatedAt = new Date();
    await existing.save();

    res.json({
      imageUrl,
      word: existing,
      provider: 'stability',
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to regenerate image.' });
  }
});

// POST /api/words/bulk/generate-images
router.post('/bulk/generate-images', async (req, res) => {
  try {
    if (!STABILITY_API_KEY) {
      return res.status(400).json({ message: 'Stability image generation is not configured.' });
    }

    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Only creators can generate word images in bulk.' });
    }

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map((id) => String(id)) : [];
    const forceRegenerate = Boolean(req.body && req.body.force);

    let targetWords = [];
    if (!isDbConnected()) {
      const availableWords = getDevScopedWords(context);
      targetWords = ids.length ? availableWords.filter((word) => ids.includes(String(word._id))) : availableWords;
    } else {
      const query = buildDbWordQuery(context);
      if (ids.length) query._id = { $in: ids };
      targetWords = await Word.find(query).sort({ createdAt: -1 });
    }

    if (!targetWords.length) {
      return res.status(400).json({ message: 'No words available for image generation.' });
    }

    let generatedCount = 0;
    let reusedCount = 0;
    let failedCount = 0;
    const results = [];

    for (const word of targetWords) {
      try {
        const generated = await generateAndPersistWordImage(word, forceRegenerate);
        const imageUrl = generated.imageUrl;

        if (!generated.reused) {
          if (!isDbConnected()) {
            if (GLOBAL_WORD_SCOPE) {
              devStore.updateWordGlobal(word._id, { imageUrl });
            } else {
              devStore.updateWord(word._id, word.userId, { imageUrl });
            }
          } else {
            word.imageUrl = imageUrl;
            word.updatedAt = new Date();
            await word.save();
          }
          generatedCount += 1;
        } else {
          reusedCount += 1;
        }

        results.push({ id: String(word._id), word: word.word, imageUrl, reused: generated.reused });
      } catch (err) {
        failedCount += 1;
        results.push({ id: String(word._id), word: word.word, error: err.message || 'Generation failed.' });
      }
    }

    res.json({
      total: targetWords.length,
      generated: generatedCount,
      reused: reusedCount,
      failed: failedCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate images in bulk.' });
  }
});

// ============================================================================
// BULK OPERATIONS
// ============================================================================

// POST /api/words/bulk/assign-deck - Assign many words to a deck (or unassign)
router.post('/bulk/assign-deck', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Only creators can update deck assignments.' });
    }

    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const deckId = normalizeDeckId(req.body && req.body.deckId);

    if (!ids.length) {
      return res.status(400).json({ message: 'Provide a non-empty array of word IDs.' });
    }

    if (deckId) {
      if (!isDbConnected()) {
        const deck = devStore.findDeckById(deckId);
        if (!deck || String(deck.creatorId) !== String(context.sourceUserId)) {
          return res.status(403).json({ message: 'Deck not found or access denied.' });
        }
      } else {
        const deck = await Deck.findById(deckId).select('_id creatorId');
        if (!deck || String(deck.creatorId) !== String(context.sourceUserId)) {
          return res.status(403).json({ message: 'Deck not found or access denied.' });
        }
      }
    }

    if (!isDbConnected()) {
      let updated = 0;
      ids.forEach((id) => {
        const result = GLOBAL_WORD_SCOPE
          ? devStore.updateWordGlobal(id, { deckId, domain: resolveScopedDomain({ deckId }) })
          : devStore.updateWord(id, context.sourceUserId, { deckId, domain: resolveScopedDomain({ deckId }) });
        if (result) updated += 1;
      });
      return res.json({ updated, deckId });
    }

    const query = GLOBAL_WORD_SCOPE
      ? { _id: { $in: ids } }
      : { _id: { $in: ids }, userId: context.sourceUserId };
    const result = await Word.updateMany(query, { $set: { deckId, domain: resolveScopedDomain({ deckId }) } });
    return res.json({ updated: result.modifiedCount || 0, deckId });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to update deck assignments.' });
  }
});

// POST /api/words/bulk/import - Bulk import words
router.post('/bulk/import', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Only creators can import words.' });
    }

    const { words, autoGenerate = true } = req.body;
    if (!Array.isArray(words) || words.length === 0) {
      return res.status(400).json({ message: 'Please provide an array of words.' });
    }

    const prepared = [];
    let skippedInvalid = 0;
    let autoGeneratedCount = 0;
    let autoImageCount = 0;

    for (const raw of words) {
      const candidate = buildWordRecord(raw);
      if (!candidate.word) {
        skippedInvalid += 1;
        continue;
      }

      const enrichedDefinition = autoGenerate ? await enrichMissingDefinition(candidate) : candidate;
      const enriched = autoGenerate ? await enrichMissingImage(enrichedDefinition) : enrichedDefinition;
      const completeEntry = ensureCompleteWordMetadata(enriched);

      if (!safeText(completeEntry.definition) || !safeText(completeEntry.example)) {
        skippedInvalid += 1;
        continue;
      }

      if (enriched.autoGenerated) autoGeneratedCount += 1;
      if (enriched.imageAutoGenerated) autoImageCount += 1;
      prepared.push(completeEntry);
    }

    if (!prepared.length) {
      return res.status(400).json({ message: 'No valid words to import.' });
    }

    const existingKeySet = new Set();
    const allPreparedHaveDeck = prepared.length && prepared.every((p) => Boolean(normalizeDeckId(p.deckId)));
    if (!isDbConnected()) {
      getDevScopedWords(context).forEach((w) => {
        const deckKey = normalizeDeckId(w.deckId) || '';
        const entryKey = autoGenerate ? `${dedupeWordKey(w.word)}::${deckKey}` : `${dedupeKey(w.word, w.definition)}::${deckKey}`;
        existingKeySet.add(entryKey);
      });
    } else {
      // If auto-generate is enabled and all incoming items explicitly target a deck,
      // skip cross-deck duplicate checks to allow same words in different decks.
      if (autoGenerate && allPreparedHaveDeck) {
        // leave existingKeySet empty to only dedupe within incoming payload
      } else {
        const uniqueWordList = Array.from(new Set(prepared.map((w) => w.word.toLowerCase())));
        const existingWords = await Word.find({
          userId: context.sourceUserId,
          word: { $in: uniqueWordList.map((w) => new RegExp(`^${w.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}$`, 'i')) },
        }).select('word definition deckId');
        existingWords.forEach((w) => {
          const deckKey = normalizeDeckId(w.deckId) || '';
          const entryKey = autoGenerate ? `${dedupeWordKey(w.word)}::${deckKey}` : `${dedupeKey(w.word, w.definition)}::${deckKey}`;
          existingKeySet.add(entryKey);
        });
      }
    }

    const incomingKeySet = new Set();
    const finalWords = [];
    let skippedDuplicates = 0;

    // DEBUG: log prepared and existing keys for troubleshooting duplicate logic
    try {
      console.log('BULK IMPORT: prepared count=', prepared.length, 'autoGenerate=', autoGenerate);
    } catch (e) {}

    for (const item of prepared) {
      try { console.log('BULK IMPORT: prepared item=', item.word, 'deck=', item.deckId); } catch (e) {}
      const deckKey = normalizeDeckId(item.deckId) || '';
      const key = autoGenerate ? `${dedupeWordKey(item.word)}::${deckKey}` : `${dedupeKey(item.word, item.definition)}::${deckKey}`;
      try { if (incomingKeySet.size < 5) console.log('BULK IMPORT: incoming key', key); } catch (e) {}
      if (incomingKeySet.has(key) || existingKeySet.has(key)) {
        skippedDuplicates += 1;
        continue;
      }
      incomingKeySet.add(key);
      finalWords.push(item);
    }

    if (!finalWords.length) {
      return res.json({
        imported: 0,
        words: [],
        autoGenerated: autoGeneratedCount,
        autoImages: autoImageCount,
        skippedInvalid,
        skippedDuplicates,
        message: 'All imported entries were duplicates or invalid.',
      });
    }

    const normalizedFinalWords = finalWords.map((item) => {
      const normalizedDeckId = normalizeDeckId(item.deckId);
      return {
        ...item,
        deckId: normalizedDeckId,
        domain: resolveScopedDomain({ domain: item.domain, deckId: normalizedDeckId }),
      };
    });

    const requestedDeckIds = Array.from(new Set(normalizedFinalWords.map((item) => item.deckId).filter(Boolean)));
    if (requestedDeckIds.length) {
      if (!isDbConnected()) {
        const invalidDeck = requestedDeckIds.find((id) => {
          const deck = devStore.findDeckById(id);
          return !deck || String(deck.creatorId) !== String(context.sourceUserId);
        });
        if (invalidDeck) {
          return res.status(403).json({ message: 'One or more deck IDs are invalid for this creator.' });
        }
      } else {
        const ownedDeckCount = await Deck.countDocuments({
          _id: { $in: requestedDeckIds },
          creatorId: context.sourceUserId,
        });
        if (ownedDeckCount !== requestedDeckIds.length) {
          return res.status(403).json({ message: 'One or more deck IDs are invalid for this creator.' });
        }
      }
    }

    if (!isDbConnected()) {
      const created = normalizedFinalWords.map((w) => devStore.createWord(context.sourceUserId, w));
      return res.json({
        imported: created.length,
        words: created,
        autoGenerated: autoGeneratedCount,
        autoImages: autoImageCount,
        skippedInvalid,
        skippedDuplicates,
      });
    }

    const created = await Word.insertMany(
      normalizedFinalWords.map((w) => ({
        userId: context.sourceUserId,
        word: w.word,
        definition: w.definition,
        language: w.language || 'en',
        partOfSpeech: w.partOfSpeech || 'other',
        example: w.example || '',
        notes: w.notes || '',
        imageUrl: w.imageUrl || '',
        difficulty: w.difficulty || 3,
        domain: w.domain,
        tags: w.tags || [],
        deckId: w.deckId,
        createdAt: new Date(),
      }))
    );

    res.status(201).json({
      imported: created.length,
      words: created,
      autoGenerated: autoGeneratedCount,
      autoImages: autoImageCount,
      skippedInvalid,
      skippedDuplicates,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to import words: ' + err.message });
  }
});

// POST /api/words/bulk/export - Export words as CSV
router.post('/bulk/export', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    let words;
    if (!isDbConnected()) {
      words = getDevScopedWords(context);
    } else {
      words = await Word.find(buildDbWordQuery(context));
    }

    // Convert to CSV
    const headers = ['word', 'definition', 'language', 'partOfSpeech', 'example', 'difficulty'];
    const csv = [
      headers.join(','),
      ...words.map(w => [
        `"${w.word}"`,
        `"${w.definition}"`,
        w.language,
        w.partOfSpeech,
        `"${w.example || ''}"`,
        w.difficulty,
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=words.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: 'Failed to export words.' });
  }
});

// POST /api/words/bulk/delete - Delete multiple words
router.post('/bulk/delete', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });
    if (!context.canManageWords) {
      return res.status(403).json({ message: 'Only creators can delete words.' });
    }

    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ message: 'Provide an array of word IDs.' });
    }

    if (!isDbConnected()) {
      let deleted = 0;
      ids.forEach(id => {
        const removed = GLOBAL_WORD_SCOPE
          ? devStore.deleteWordGlobal(id)
          : devStore.deleteWord(id, context.sourceUserId);
        if (removed) deleted++;
      });
      return res.json({ deleted });
    }

    const result = GLOBAL_WORD_SCOPE
      ? await Word.deleteMany({ _id: { $in: ids } })
      : await Word.deleteMany({ _id: { $in: ids }, userId: context.sourceUserId });

    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete words.' });
  }
});

// GET /api/words/search - Advanced search
router.get('/search', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    const { q, language, difficulty, limit = 20, skip = 0 } = req.query;

    if (!isDbConnected()) {
      let words = getDevScopedWords(context);

      if (q) {
        const query = q.toLowerCase();
        words = words.filter(w =>
          w.word.toLowerCase().includes(query) ||
          w.definition.toLowerCase().includes(query)
        );
      }
      if (language) words = words.filter(w => w.language === language);
      if (difficulty) words = words.filter(w => w.difficulty == difficulty);

      return res.json({
        words: words.slice(skip, skip + limit),
        total: words.length,
      });
    }

    const query = buildDbWordQuery(context);

    if (q) {
      query.$or = [
        { word: { $regex: q, $options: 'i' } },
        { definition: { $regex: q, $options: 'i' } },
      ];
    }

    if (language) query.language = language;
    if (difficulty) query.difficulty = parseInt(difficulty);

    const total = await Word.countDocuments(query);
    const words = await Word.find(query)
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .sort({ createdAt: -1 });

    res.json({ words, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (err) {
    res.status(500).json({ message: 'Search failed.' });
  }
});

// GET /api/words/analytics - Detailed analytics
router.get('/analytics', async (req, res) => {
  try {
    const context = await getWordAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    if (!isDbConnected()) {
      const words = getDevScopedWords(context);

      const languages = {};
      const difficulties = {};
      const pos = {};

      words.forEach(w => {
        const lang = w.language || 'other';
        const diff = w.difficulty || 1;
        const p = w.partOfSpeech || 'other';

        languages[lang] = (languages[lang] || 0) + 1;
        difficulties[diff] = (difficulties[diff] || 0) + 1;
        pos[p] = (pos[p] || 0) + 1;
      });

      return res.json({
        total: words.length,
        languages,
        difficulties,
        partOfSpeech: pos,
        averageDifficulty: words.length > 0 ? (words.reduce((s, w) => s + (w.difficulty || 1), 0) / words.length).toFixed(1) : 0,
      });
    }

    const stats = await Word.aggregate([
      { $match: buildDbWordQuery(context) },
      {
        $facet: {
          total: [{ $count: 'count' }],
          byLanguage: [
            { $group: { _id: '$language', count: { $sum: 1 } } },
          ],
          byDifficulty: [
            { $group: { _id: '$difficulty', count: { $sum: 1 } } },
          ],
          byPOS: [
            { $group: { _id: '$partOfSpeech', count: { $sum: 1 } } },
          ],
          avgDifficulty: [
            { $group: { _id: null, avg: { $avg: '$difficulty' } } },
          ],
        },
      },
    ]);

    const data = stats[0];
    res.json({
      total: data.total[0]?.count || 0,
      languages: Object.fromEntries(data.byLanguage.map(x => [x._id || 'other', x.count])),
      difficulties: Object.fromEntries(data.byDifficulty.map(x => [x._id || 1, x.count])),
      partOfSpeech: Object.fromEntries(data.byPOS.map(x => [x._id || 'other', x.count])),
      averageDifficulty: data.avgDifficulty[0]?.avg?.toFixed(1) || 0,
    });
  } catch (err) {
    res.status(500).json({ message: 'Analytics failed.' });
  }
});

module.exports = router;
module.exports.buildPollinationsPrompt = buildPollinationsPrompt;
module.exports.buildPollinationsImageUrl = buildPollinationsImageUrl;
module.exports.buildStabilityPrompt = buildStabilityPrompt;
module.exports.isLikelyAbstractWord = isLikelyAbstractWord;
module.exports.isGeneratedImageUrl = isGeneratedImageUrl;
module.exports.isPollinationsImageUrl = isPollinationsImageUrl;
module.exports.shouldUsePollinationsDisplayImage = shouldUsePollinationsDisplayImage;
module.exports.shouldReuseExistingImage = shouldReuseExistingImage;
module.exports.buildUnsplashSearchQueries = buildUnsplashSearchQueries;
module.exports.scoreUnsplashResult = scoreUnsplashResult;
module.exports.resolveWordDisplayImage = resolveWordDisplayImage;
module.exports.buildFallbackImageUrl = buildFallbackImageUrl;
module.exports.normalizeDifficulty = normalizeDifficulty;
module.exports.normalizeDomain = normalizeDomain;
module.exports.normalizeTargetBand = normalizeTargetBand;
module.exports.normalizeStatus = normalizeStatus;
