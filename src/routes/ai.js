const express = require('express');
const router = express.Router();

function buildPrompt({ text, language = 'English', maxItems = 500 }) {
  const safeText = String(text || '').replace(/`/g, "'");
  return `You are an assistant that extracts vocabulary items from arbitrary user text and returns a JSON array only.\n\nInput language: ${language}\nTask:\n1) Extract candidate vocabulary items (single words or multi-word phrases) from the input text.\n2) Normalize each item to base form (lemma) if applicable.\n3) Deduplicate and return at most ${maxItems} items.\n4) For each item, provide fields: word, normalized, definition (one short sentence), example (one sentence using the word), partOfSpeech.\n5) Output must be valid JSON array and nothing else.\n\nUser text:\n"""${safeText}\"\"\"\n\nRespond with a JSON array.`;
}

router.post('/parse-and-enrich', async (req, res) => {
  try {
    const { text, language, maxItems } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

    const prompt = buildPrompt({ text, language, maxItems: Number(maxItems) || 500 });
    return res.status(501).json({
      error: 'This parser is disabled. Use the main vocab generation flow with Groq/Gemini/OpenAI instead.',
      promptPreview: String(prompt).slice(0, 120),
    });
  } catch (err) {
    console.error('AI parse error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
