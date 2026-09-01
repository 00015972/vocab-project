const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPollinationsImageUrl, buildPollinationsPrompt, buildStabilityPrompt, buildUnsplashSearchQueries, isGeneratedImageUrl, isLikelyAbstractWord, isPollinationsImageUrl, resolveWordDisplayImage, scoreUnsplashResult, shouldReuseExistingImage, shouldUsePollinationsDisplayImage } = require('../src/routes/words');

test('buildPollinationsPrompt uses the word and meaning for educational visuals', () => {
  const prompt = buildPollinationsPrompt('apple', 'a round fruit with red or green skin', 'noun');

  assert.match(prompt, /apple/i);
  assert.match(prompt, /round fruit/i);
  assert.match(prompt, /classroom friendly/i);
  assert.match(prompt, /no text/i);
});

test('buildPollinationsPrompt gives logical concrete scenes for abstract words', () => {
  const prompt = buildPollinationsPrompt('honesty', 'the quality of being truthful and sincere', 'noun');

  assert.match(prompt, /relatable educational illustration/i);
  assert.match(prompt, /returning a lost wallet|act of honesty|truth/i);
  assert.match(prompt, /avoid surreal patterns|literal/i);
});

test('buildPollinationsPrompt gives anchored details for concrete words', () => {
  const prompt = buildPollinationsPrompt('bicycle', 'a vehicle with two wheels and pedals', 'noun');

  assert.match(prompt, /clear central subject/i);
  assert.match(prompt, /two|wheels|pedals/i);
  assert.match(prompt, /avoid abstract textures/i);
});

test('buildPollinationsImageUrl returns a Pollinations prompt URL', () => {
  const url = buildPollinationsImageUrl('apple', 'a round fruit with red or green skin', 'noun');

  assert.match(url, /^https:\/\/image\.pollinations\.ai\/prompt\//i);
  assert.match(url, /width=900/i);
  assert.match(url, /height=560/i);
});

test('buildStabilityPrompt includes the vocab meaning and image constraints', () => {
  const prompt = buildStabilityPrompt('apple', 'a round fruit with red or green skin', 'noun');

  assert.match(prompt, /apple/i);
  assert.match(prompt, /round fruit/i);
  assert.match(prompt, /noun/i);
  assert.match(prompt, /No text, no labels, no watermark/i);
});

test('buildStabilityPrompt uses relatable scenes for abstract words', () => {
  const prompt = buildStabilityPrompt('honesty', 'the quality of being truthful and sincere', 'noun');

  assert.equal(isLikelyAbstractWord('honesty', 'the quality of being truthful and sincere', 'noun'), true);
  assert.match(prompt, /relatable everyday situation/i);
  assert.match(prompt, /facial expression|body language|simple scene/i);
});

test('buildUnsplashSearchQueries uses the word plus meaning clues', () => {
  const queries = buildUnsplashSearchQueries('apple', 'a round fruit with sweet flesh');

  assert(queries.length > 0);
  assert(queries.some((query) => query.includes('apple')));
  assert(queries.some((query) => query.includes('fruit')));
  assert(queries.some((query) => query.includes('apple fruit')));
});

test('scoreUnsplashResult prefers results that match the word and meaning', () => {
  const relevant = scoreUnsplashResult('apple', 'a round fruit with sweet flesh', {
    alt_description: 'red apple fruit on white background',
    description: 'A fresh red apple fruit',
  });
  const generic = scoreUnsplashResult('apple', 'a round fruit with sweet flesh', {
    alt_description: 'sunset over a calm forest',
    description: 'A scenic forest view',
  });

  assert(relevant > generic);
});

test('shouldReuseExistingImage only reuses generated local images when not forced', () => {
  assert.equal(isGeneratedImageUrl('/generated/apple-123.png'), true);
  assert.equal(isPollinationsImageUrl('https://image.pollinations.ai/prompt/apple?width=900&height=560'), true);
  assert.equal(shouldReuseExistingImage({ imageUrl: '/generated/apple-123.png' }, false), true);
  assert.equal(shouldReuseExistingImage({ imageUrl: 'https://image.pollinations.ai/prompt/apple?width=900&height=560' }, false), true);
  assert.equal(shouldReuseExistingImage({ imageUrl: 'https://images.unsplash.com/photo-1' }, false), false);
  assert.equal(shouldReuseExistingImage({ imageUrl: '/generated/apple-123.png' }, true), false);
});

test('shouldUsePollinationsDisplayImage replaces stale remote image URLs', () => {
  assert.equal(shouldUsePollinationsDisplayImage({ imageUrl: '' }), true);
  assert.equal(shouldUsePollinationsDisplayImage({ imageUrl: 'https://images.unsplash.com/photo-1' }), true);
  assert.equal(shouldUsePollinationsDisplayImage({ imageUrl: 'https://image.pollinations.ai/prompt/apple?width=900&height=560' }), false);
  assert.equal(shouldUsePollinationsDisplayImage({ imageUrl: '/generated/apple-123.png' }), false);
});

test('resolveWordDisplayImage returns a fast fallback without remote lookups', () => {
  const word = { word: 'apple', definition: 'a round fruit', imageUrl: '' };
  const resolved = resolveWordDisplayImage(word, { allowRemote: false });

  assert.equal(resolved.imageUrl.includes('loremflickr.com') || resolved.imageUrl.includes('apple'), true);
  assert.equal(resolved.word, 'apple');
});
