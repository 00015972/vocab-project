const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const audioService = require('../services/audioService');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

router.use(auth);

function resolveReferenceUrl(referenceUrl, req) {
  const trimmed = String(referenceUrl || '').trim();
  if (!trimmed) return '';

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return `${req.protocol}://${req.get('host')}${trimmed}`;
  return `${req.protocol}://${req.get('host')}/${trimmed.replace(/^\/+/, '')}`;
}

// POST /api/audio/check-pronunciation
router.post('/check-pronunciation', upload.single('userAudio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ message: 'userAudio file is required.' });
    }

    const resolvedReferenceUrl = resolveReferenceUrl(req.body?.referenceUrl, req);
    if (!resolvedReferenceUrl) {
      return res.status(400).json({ message: 'referenceUrl is required.' });
    }

    const language = String(req.body?.language || 'en').trim().toLowerCase() || 'en';
    const result = await audioService.checkPronunciation(req.file.buffer, resolvedReferenceUrl, language);

    return res.json({
      score: Number.isFinite(Number(result?.score)) ? Number(result.score) : 0,
      feedback: String(result?.feedback || 'Could not check pronunciation. Please try again.'),
      userTranscription: result?.userTranscription || null,
      referenceTranscription: result?.referenceTranscription || null,
    });
  } catch (err) {
    console.error('Pronunciation API error:', err);
    return res.status(500).json({ message: 'Pronunciation check failed.' });
  }
});

module.exports = router;
