const express = require('express');
const router = express.Router();
const Word = require('../models/Word');
const Deck = require('../models/Deck');
const User = require('../models/User');
const auth = require('../middleware/auth');
const importExportService = require('../utils/importExport');
const { isDbConnected } = require('../config/db');

router.use(auth);

// POST /api/import - Import words from file
router.post('/', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline. Import unavailable.' });
    }

    const { content, filename, deckId } = req.body;
    if (!content || !filename) {
      return res.status(400).json({ message: 'Content and filename are required.' });
    }

    // Parse file
    let parsedWords = [];
    try {
      parsedWords = importExportService.parseAuto(content, filename);
    } catch (err) {
      return res.status(400).json({ message: `Import failed: ${err.message}` });
    }

    // Validate words
    const { valid, errors } = importExportService.validateWords(parsedWords);
    if (valid.length === 0) {
      return res.status(400).json({ message: 'No valid words found.', errors });
    }

    // Get or create default deck
    let deck = null;
    if (deckId) {
      deck = await Deck.findById(deckId);
      if (!deck || deck.creatorId.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Deck not found or access denied.' });
      }
    } else {
      // Create default deck
      const deckName = filename.replace(/\.[^/.]+$/, ''); // Remove extension
      deck = new Deck({
        creatorId: req.user.id,
        name: deckName || 'Imported Deck',
      });
      await deck.save();
    }

    // Insert words
    const wordsToInsert = valid.map((w) => ({
      ...w,
      userId: req.user.id,
      deckId: deck._id,
    }));

    const inserted = await Word.insertMany(wordsToInsert);

    // Update deck word count
    deck.wordCount = await Word.countDocuments({ deckId: deck._id });
    await deck.save();

    res.json({
      message: `${inserted.length} words imported successfully.`,
      deckId: deck._id,
      deckName: deck.name,
      imported: inserted.length,
      skipped: errors.length,
      errors: errors.slice(0, 10), // First 10 errors
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ message: 'Import failed.' });
  }
});

// GET /api/export - Export words
router.get('/', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline. Export unavailable.' });
    }

    const { deckId, format } = req.query;
    if (!format || !['csv', 'json', 'tsv'].includes(format)) {
      return res.status(400).json({ message: 'Format must be csv, json, or tsv.' });
    }

    let query = { userId: req.user.id };
    let deckName = 'vocabulary';

    if (deckId) {
      const deck = await Deck.findById(deckId);
      if (!deck || deck.creatorId.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Access denied.' });
      }
      query.deckId = deckId;
      deckName = deck.name;
    }

    const words = await Word.find(query).select('-userId -deckId -createdAt -updatedAt -__v');

    // Export based on format
    let content, mimeType, extension;

    if (format === 'csv') {
      content = importExportService.exportCSV(words);
      mimeType = 'text/csv';
      extension = 'csv';
    } else if (format === 'json') {
      content = importExportService.exportJSON(words);
      mimeType = 'application/json';
      extension = 'json';
    } else if (format === 'tsv') {
      content = importExportService.exportTSV(words);
      mimeType = 'text/tab-separated-values';
      extension = 'tsv';
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${deckName}-${new Date().toISOString().split('T')[0]}.${extension}"`
    );
    res.send(content);
  } catch (err) {
    res.status(500).json({ message: 'Export failed.' });
  }
});

// GET /api/export/anki - Export to Anki format (simplified JSON)
router.get('/anki', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(503).json({ message: 'Database offline.' });
    }

    const { deckId } = req.query;
    let query = { userId: req.user.id };
    let deckName = 'vocabulary';

    if (deckId) {
      const deck = await Deck.findById(deckId);
      if (!deck || deck.creatorId.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Access denied.' });
      }
      query.deckId = deckId;
      deckName = deck.name;
    }

    const words = await Word.find(query);

    // Convert to Anki format (note: full .apkg requires ZIP compression)
    // For now, export as JSON that can be imported into Anki
    const ankiNotes = words.map((w) => ({
      deckName,
      modelName: 'Basic',
      fields: {
        Front: w.word,
        Back: `${w.definition}\n\nExample: ${w.example || 'N/A'}\n(${w.partOfSpeech})`,
      },
      tags: w.tags || [],
    }));

    const filename = `${deckName}-anki-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(ankiNotes);
  } catch (err) {
    res.status(500).json({ message: 'Anki export failed.' });
  }
});

module.exports = router;
