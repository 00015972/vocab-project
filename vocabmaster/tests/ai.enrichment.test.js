const test = require('node:test');
const assert = require('node:assert/strict');

const aiRoute = require('../src/routes/ai');
const { normalizeGeneratedWordList } = aiRoute.__internals || {};

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
