const express = require('express');
const router = express.Router();
const Deck = require('../models/Deck');
const Word = require('../models/Word');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { isDbConnected } = require('../config/db');
const devStore = require('../services/devStore');

const GLOBAL_WORD_SCOPE = String(process.env.WORD_SCOPE || 'global').toLowerCase() === 'global';

router.use(auth);

function safeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDifficulty(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(5, Math.round(numeric))) : 3;
}

function isWordMastered(word) {
  const status = safeText(word && word.learningStatus).toLowerCase();
  return status === 'mastered' || Boolean(word && word.adaptiveMetrics && word.adaptiveMetrics.masteredAt);
}

function normalizeDeckImageUrl(value) {
  const imageUrl = safeText(value);
  if (!imageUrl) return '';
  if (imageUrl.startsWith('https://image.pollinations.ai/')) {
    return '/api/image-proxy?url=' + encodeURIComponent(imageUrl);
  }
  return imageUrl;
}

async function getDeckAccessContext(userId) {
  if (!isDbConnected()) {
    const user = devStore.findUserById(userId);
    if (!user) return null;
    const role = user.role || 'creator';
    if (GLOBAL_WORD_SCOPE) {
      return { user, role, sourceUserIds: [userId] };
    }
    if (role === 'student') {
      const creatorIds = devStore
        .listUsers()
        .filter((entry) => (entry.role || 'student') === 'creator')
        .map((entry) => String(entry._id));
      return { user, role, sourceUserIds: creatorIds };
    }
    return { user, role, sourceUserIds: [userId] };
  }

  const user = await User.findById(userId).select('role').lean();
  if (!user) return null;
  const role = user.role || 'creator';
  if (GLOBAL_WORD_SCOPE) {
    return { user, role, sourceUserIds: [userId] };
  }
  if (role === 'student') {
    const creatorRows = await User.find({ role: 'creator' }).select('_id').lean();
    return { user, role, sourceUserIds: creatorRows.map((entry) => String(entry._id)) };
  }
  return { user, role, sourceUserIds: [userId] };
}

function buildAccessibleCreatorIds(context) {
  if (GLOBAL_WORD_SCOPE) return null;
  return Array.isArray(context && context.sourceUserIds)
    ? context.sourceUserIds.map((value) => String(value || '')).filter(Boolean)
    : [];
}

function buildDeckCatalog(decks, words) {
  const deckWordsMap = new Map();
  (Array.isArray(words) ? words : []).forEach((word) => {
    const deckId = safeText(word && word.deckId);
    if (!deckId) return;
    if (!deckWordsMap.has(deckId)) deckWordsMap.set(deckId, []);
    deckWordsMap.get(deckId).push(word);
  });

  return (Array.isArray(decks) ? decks : []).map((deck) => {
    const deckId = String(deck && deck._id || '');
    const deckWords = deckWordsMap.get(deckId) || [];
    const topic = safeText(deck && deck.topic);
    const name = safeText(deck && deck.name);
    return {
      _id: deckId,
      name,
      topic,
      title: topic || name || 'Untitled Deck',
      subtitle: topic && name && topic !== name ? name : '',
      description: safeText(deck && deck.description),
      difficulty: safeText(deck && deck.difficulty) || 'intermediate',
      isPublic: Boolean(deck && deck.isPublic),
      updatedAt: deck && (deck.updatedAt || deck.createdAt) ? (deck.updatedAt || deck.createdAt) : null,
      wordCount: deckWords.length,
      masteredCount: deckWords.filter(isWordMastered).length,
      sampleWords: deckWords.slice(0, 4).map((word) => safeText(word && word.word)).filter(Boolean),
      previewImage: normalizeDeckImageUrl(safeText(deck && deck.coverImage) || safeText(deckWords[0] && deckWords[0].imageUrl)),
    };
  }).sort((left, right) => {
    const leftTime = new Date(left.updatedAt || 0).getTime();
    const rightTime = new Date(right.updatedAt || 0).getTime();
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.title.localeCompare(right.title);
  });
}

function normalizeDeckPayload(body = {}) {
  const tags = Array.isArray(body.tags)
    ? body.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
    : String(body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);

  return {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    tags,
    difficulty: String(body.difficulty || 'intermediate').trim() || 'intermediate',
    topic: String(body.topic || '').trim(),
    language: String(body.language || 'English').trim() || 'English',
    isPublic: Boolean(body.isPublic),
    isFeatured: Boolean(body.isFeatured),
    coverImage: String(body.coverImage || '').trim(),
  };
}

// GET /api/decks - List user's decks
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);

    if (!isDbConnected()) {
      const decks = devStore.listDecksByCreator(req.user.id);
      return res.json({ decks: decks.slice(skip, skip + limit), total: decks.length, limit, skip });
    }

    const total = await Deck.countDocuments({ creatorId: req.user.id });
    const decks = await Deck.find({ creatorId: req.user.id })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .skip(skip);

    res.json({ decks, total, limit, skip });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch decks.' });
  }
});

// GET /api/decks/public - Browse public decks
router.get('/public', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = Math.max(parseInt(req.query.skip) || 0, 0);
    const search = req.query.search || '';
    const tag = req.query.tag || '';

    if (!isDbConnected()) {
      const decks = devStore.listPublicDecks({ search, tag });
      return res.json({ decks: decks.slice(skip, skip + limit), total: decks.length, limit, skip });
    }

    const query = { isPublic: true };
    if (search) query.name = { $regex: search, $options: 'i' };
    if (tag) query.tags = tag;

    const total = await Deck.countDocuments(query);
    const decks = await Deck.find(query)
      .sort({ downloads: -1, createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .select('name description tags difficulty wordCount downloads coverImage');

    res.json({ decks, total, limit, skip });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch public decks.' });
  }
});

router.get('/catalog', async (req, res) => {
  try {
    const context = await getDeckAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    if (!isDbConnected()) {
      const store = devStore.readStore();
      const creatorIds = buildAccessibleCreatorIds(context);
      const decks = (store.decks || []).filter((deck) => {
        if (GLOBAL_WORD_SCOPE) return true;
        return creatorIds.includes(String(deck && deck.creatorId || ''));
      });
      const words = (store.words || []).filter((word) => {
        if (!safeText(word && word.deckId)) return false;
        if (GLOBAL_WORD_SCOPE) return true;
        return creatorIds.includes(String(word && word.userId || ''));
      });
      return res.json({ decks: buildDeckCatalog(decks, words) });
    }

    const creatorIds = buildAccessibleCreatorIds(context);
    const deckQuery = GLOBAL_WORD_SCOPE ? {} : { creatorId: { $in: creatorIds } };
    const wordQuery = GLOBAL_WORD_SCOPE
      ? { deckId: { $exists: true, $ne: null } }
      : { userId: { $in: creatorIds }, deckId: { $exists: true, $ne: null } };

    const [decks, words] = await Promise.all([
      Deck.find(deckQuery).sort({ updatedAt: -1, createdAt: -1 }).lean(),
      Word.find(wordQuery).select('_id deckId word imageUrl learningStatus adaptiveMetrics').lean(),
    ]);

    return res.json({ decks: buildDeckCatalog(decks, words) });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load deck catalog.' });
  }
});

router.get('/catalog/:id/practice', async (req, res) => {
  try {
    const context = await getDeckAccessContext(req.user.id);
    if (!context) return res.status(404).json({ message: 'User not found.' });

    if (!isDbConnected()) {
      const store = devStore.readStore();
      const creatorIds = buildAccessibleCreatorIds(context);
      const deck = (store.decks || []).find((entry) => {
        if (String(entry && entry._id || '') !== String(req.params.id || '')) return false;
        if (GLOBAL_WORD_SCOPE) return true;
        return creatorIds.includes(String(entry && entry.creatorId || ''));
      });
      if (!deck) return res.status(404).json({ message: 'Deck not found.' });
      const words = (store.words || []).filter((word) => {
        if (String(word && word.deckId || '') !== String(deck._id || '')) return false;
        if (GLOBAL_WORD_SCOPE) return true;
        return creatorIds.includes(String(word && word.userId || ''));
      }).map((word) => ({
        _id: String(word && word._id || ''),
        deckId: String(deck && deck._id || ''),
        word: safeText(word && word.word),
        definition: safeText(word && word.definition),
        example: safeText(word && word.example),
        difficulty: normalizeDifficulty(word && word.difficulty),
        imageUrl: normalizeDeckImageUrl(word && word.imageUrl),
      })).filter((word) => word.word && word.definition);

      return res.json({
        deck: {
          _id: String(deck && deck._id || ''),
          name: safeText(deck && deck.name),
          topic: safeText(deck && deck.topic),
          description: safeText(deck && deck.description),
        },
        words,
      });
    }

    const creatorIds = buildAccessibleCreatorIds(context);
    const deckQuery = GLOBAL_WORD_SCOPE
      ? { _id: req.params.id }
      : { _id: req.params.id, creatorId: { $in: creatorIds } };
    const deck = await Deck.findOne(deckQuery).lean();
    if (!deck) return res.status(404).json({ message: 'Deck not found.' });

    const wordQuery = GLOBAL_WORD_SCOPE
      ? { deckId: req.params.id }
      : { deckId: req.params.id, userId: { $in: creatorIds } };
    const words = await Word.find(wordQuery)
      .sort({ createdAt: -1 })
      .select('_id deckId word definition example difficulty imageUrl')
      .lean();

    return res.json({
      deck: {
        _id: String(deck && deck._id || ''),
        name: safeText(deck && deck.name),
        topic: safeText(deck && deck.topic),
        description: safeText(deck && deck.description),
      },
      words: words.map((word) => ({
        _id: String(word && word._id || ''),
        deckId: String(word && word.deckId || ''),
        word: safeText(word && word.word),
        definition: safeText(word && word.definition),
        example: safeText(word && word.example),
        difficulty: normalizeDifficulty(word && word.difficulty),
        imageUrl: normalizeDeckImageUrl(word && word.imageUrl),
      })).filter((word) => word.word && word.definition),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to load deck practice data.' });
  }
});

// POST /api/decks - Create deck
router.post('/', async (req, res) => {
  try {
    const payload = normalizeDeckPayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ message: 'Deck name is required.' });
    }

    if (!isDbConnected()) {
      const existing = devStore.listDecksByCreator(req.user.id).find((deck) => deck.name.toLowerCase() === payload.name.toLowerCase());
      if (existing) {
        return res.status(409).json({ message: 'A deck with this name already exists.' });
      }
      const deck = devStore.createDeck(req.user.id, payload);
      return res.status(201).json({ deck });
    }

    const existing = await Deck.findOne({ creatorId: req.user.id, name: payload.name });
    if (existing) {
      return res.status(409).json({ message: 'A deck with this name already exists.' });
    }

    const deck = new Deck({
      creatorId: req.user.id,
      ...payload,
    });

    await deck.save();
    res.status(201).json({ deck });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create deck.' });
  }
});

// GET /api/decks/:id - Get deck details
router.get('/:id', async (req, res) => {
  try {
    if (!isDbConnected()) {
      const deck = devStore.findDeckById(req.params.id);
      if (!deck) return res.status(404).json({ message: 'Deck not found.' });
      if (!deck.isPublic && deck.creatorId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied.' });
      }
      const words = (devStore.readStore().words || []).filter((word) => String(word.deckId || '') === String(deck._id));
      return res.json({ deck, words });
    }

    const deck = await Deck.findById(req.params.id);
    if (!deck) return res.status(404).json({ message: 'Deck not found.' });

    // Check access
    if (!deck.isPublic && deck.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const words = await Word.find({ deckId: deck._id }).sort({ createdAt: -1 });
    res.json({ deck, words });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch deck.' });
  }
});

// PUT /api/decks/:id - Update deck
router.put('/:id', async (req, res) => {
  try {
    const payload = normalizeDeckPayload(req.body);

    if (!isDbConnected()) {
      const existing = devStore.findDeckById(req.params.id);
      if (!existing) return res.status(404).json({ message: 'Deck not found.' });
      if (existing.creatorId !== req.user.id) {
        return res.status(403).json({ message: 'You can only edit your own decks.' });
      }
      const deck = devStore.updateDeck(req.params.id, req.user.id, payload);
      return res.json({ deck });
    }

    const deck = await Deck.findById(req.params.id);
    if (!deck) return res.status(404).json({ message: 'Deck not found.' });

    if (deck.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only edit your own decks.' });
    }

    if (payload.name) deck.name = payload.name;
    deck.description = payload.description;
    deck.tags = payload.tags;
    deck.difficulty = payload.difficulty;
    deck.topic = payload.topic;
    deck.language = payload.language;
    deck.isPublic = payload.isPublic;
    deck.isFeatured = payload.isFeatured;
    deck.coverImage = payload.coverImage;

    deck.updatedAt = new Date();
    await deck.save();

    res.json({ deck });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update deck.' });
  }
});

// DELETE /api/decks/:id - Delete deck
router.delete('/:id', async (req, res) => {
  try {
    if (!isDbConnected()) {
      const deleted = devStore.deleteDeck(req.params.id, req.user.id);
      if (!deleted) return res.status(404).json({ message: 'Deck not found.' });
      return res.json({ message: 'Deck deleted.' });
    }

    const deck = await Deck.findById(req.params.id);
    if (!deck) return res.status(404).json({ message: 'Deck not found.' });

    if (deck.creatorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete your own decks.' });
    }

    // Delete all words in deck
    await Word.deleteMany({ deckId: req.params.id });
    await Deck.findByIdAndDelete(req.params.id);

    res.json({ message: 'Deck deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete deck.' });
  }
});

// POST /api/decks/:id/fork - Fork a public deck
router.post('/:id/fork', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const originalDeck = await Deck.findById(req.params.id);
    if (!originalDeck || !originalDeck.isPublic) {
      return res.status(404).json({ message: 'Deck not found or not public.' });
    }

    // Create copy
    const forkedDeck = new Deck({
      creatorId: req.user.id,
      name: `${originalDeck.name} (Copy)`,
      description: originalDeck.description,
      tags: originalDeck.tags,
      difficulty: originalDeck.difficulty,
      topic: originalDeck.topic,
      isPublic: false,
    });

    await forkedDeck.save();

    // Copy words
    const words = await Word.find({ deckId: originalDeck._id });
    const copiedWords = words.map((w) => ({
      ...w.toObject(),
      _id: undefined,
      userId: req.user.id,
      deckId: forkedDeck._id,
    }));

    if (copiedWords.length > 0) {
      await Word.insertMany(copiedWords);
      forkedDeck.wordCount = copiedWords.length;
      await forkedDeck.save();
    }

    // Update original deck's fork count
    originalDeck.forks.push(req.user.id);
    await originalDeck.save();

    res.status(201).json({ deck: forkedDeck, wordCount: copiedWords.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fork deck.' });
  }
});

module.exports = router;
