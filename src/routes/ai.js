const express = require('express');
const router = express.Router();
const { callHuggingFace, HUGGINGFACE_MODEL_DEFAULT } = require('../services/hfClient');

function buildPrompt({ text, language = 'English', maxItems = 500 }) {
  const safeText = String(text || '').replace(/`/g, "'");
  return `You are an assistant that extracts vocabulary items from arbitrary user text and returns a JSON array only.\n\nInput language: ${language}\nTask:\n1) Extract candidate vocabulary items (single words or multi-word phrases) from the input text.\n2) Normalize each item to base form (lemma) if applicable.\n3) Deduplicate and return at most ${maxItems} items.\n4) For each item, provide fields: word, normalized, definition (one short sentence), example (one sentence using the word), partOfSpeech.\n5) Output must be valid JSON array and nothing else.\n\nUser text:\n"""${safeText}\"\"\"\n\nRespond with a JSON array.`;
}

router.post('/parse-and-enrich', async (req, res) => {
  try {
    const { text, language, maxItems, model } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    const prompt = buildPrompt({ text, language, maxItems: Number(maxItems) || 500 });
    const hfResp = await callHuggingFace(prompt, model || HUGGINGFACE_MODEL_DEFAULT);

    // hfResp may be string, array, or object. Try to extract JSON array.
    let raw = hfResp;
    if (Array.isArray(hfResp)) raw = hfResp.map(x => (x.generated_text || x.text || JSON.stringify(x))).join('\n');
    if (typeof hfResp === 'object' && hfResp.generated_text) raw = hfResp.generated_text;
    raw = String(raw || '');

    const match = raw.match(/(\[.*\])/s);
    if (!match) return res.status(502).json({ error: 'Could not parse JSON array from provider response', raw: raw.slice(0, 1000) });
    let items = JSON.parse(match[1]);
    if (!Array.isArray(items)) return res.status(502).json({ error: 'Provider returned non-array JSON' });

    // Normalize items
    items = items.map(it => ({
      word: String(it.word || it.text || '').trim(),
      normalized: String(it.normalized || it.lemma || it.word || '').trim(),
      definition: String(it.definition || it.def || '').trim(),
      example: String(it.example || it.sentence || '').trim(),
      partOfSpeech: String(it.partOfSpeech || it.pos || '').trim(),
    })).filter(it => it.word && it.word.length > 0);

    return res.json({ items });
  } catch (err) {
    console.error('AI parse error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
