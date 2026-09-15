const test = require('node:test');
const assert = require('node:assert/strict');

const aiRoute = require('../src/routes/ai');
const { normalizeGeneratedWordList, getHuggingFaceModelName } = aiRoute.__internals || {};

test('normalizeGeneratedWordList fills missing definition and example text for every word', () => {
  assert.ok(normalizeGeneratedWordList, 'normalizeGeneratedWordList helper should be exported for test coverage');

  const result = normalizeGeneratedWordList([
    { word: 'serendipity', definition: '', example: '', partOfSpeech: '' },
    { word: 'eloquent', definition: 'Fluent and persuasive in speech or writing.', example: '', partOfSpeech: 'adjective' },
  ]);

  assert.equal(result.length, 2);
  assert.match(result[0].definition, /serendipity/i);
  assert.match(result[0].example, /serendipity/i);
  assert.ok(['noun', 'verb', 'adjective', 'adverb', 'phrase', 'idiom', 'other'].includes(result[0].partOfSpeech));

  assert.equal(result[1].definition, 'Fluent and persuasive in speech or writing.');
  assert.match(result[1].example, /eloquent/i);
  assert.equal(result[1].partOfSpeech, 'adjective');
});

test('getHuggingFaceModelName falls back to HUGGINGFACE_MODEL_DEFAULT when no model override is set', () => {
  const original = process.env.HUGGINGFACE_MODEL;
  const defaultOriginal = process.env.HUGGINGFACE_MODEL_DEFAULT;
  delete process.env.HUGGINGFACE_MODEL;
  process.env.HUGGINGFACE_MODEL_DEFAULT = 'google/flan-t5-large';

  try {
    assert.equal(getHuggingFaceModelName(), 'google/flan-t5-large');
  } finally {
    if (original === undefined) delete process.env.HUGGINGFACE_MODEL;
    else process.env.HUGGINGFACE_MODEL = original;

    if (defaultOriginal === undefined) delete process.env.HUGGINGFACE_MODEL_DEFAULT;
    else process.env.HUGGINGFACE_MODEL_DEFAULT = defaultOriginal;
  }
});
