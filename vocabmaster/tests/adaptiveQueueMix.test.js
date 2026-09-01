const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAdaptiveQueue,
  pickCurrentBandWords,
  pickStretchWords,
  pickReviewWords,
  isCurrentBandWord,
  isStretchWord,
  isReviewWord,
} = require('../src/services/adaptiveQueueMix');

function mk(id, source, extra = {}) {
  return {
    _id: String(id),
    word: `w-${id}`,
    _planMeta: {
      source,
      inBand: source !== 'stretch',
      dueReview: source === 'due_review',
      struggling: source === 'remediation',
    },
    ...extra,
  };
}

test('pickCurrentBandWords, pickStretchWords, and pickReviewWords classify by source', () => {
  const pool = [
    mk('1', 'growth'),
    mk('2', 'new'),
    mk('3', 'stretch'),
    mk('4', 'due_review'),
    mk('5', 'remediation'),
  ];

  const usedIds = new Set();
  const current = pickCurrentBandWords(pool, 1, { usedIds, totalCount: 2 });
  const stretch = pickStretchWords(pool, 1, { usedIds, totalCount: 1 });
  const review = pickReviewWords(pool, 1, { usedIds, totalCount: 2 });

  assert.equal(current.length, 2);
  assert.equal(stretch.length, 1);
  assert.equal(review.length, 2);
  assert.equal(current.every((item) => isCurrentBandWord(item)), true);
  assert.equal(stretch.every((item) => isStretchWord(item)), true);
  assert.equal(review.every((item) => isReviewWord(item)), true);
});

test('buildAdaptiveQueue follows 70/20/10 when enough data exists', () => {
  const pool = [];
  for (let i = 0; i < 14; i += 1) pool.push(mk(`g-${i}`, 'growth'));
  for (let i = 0; i < 4; i += 1) pool.push(mk(`s-${i}`, 'stretch'));
  for (let i = 0; i < 2; i += 1) pool.push(mk(`r-${i}`, 'due_review'));

  const result = buildAdaptiveQueue('u1', { pool, wordCount: 20 });

  assert.equal(result.queue.length, 20);
  assert.equal(result.counts.current, 14);
  assert.equal(result.counts.stretch, 4);
  assert.equal(result.counts.review, 2);
});

test('buildAdaptiveQueue never returns empty when data exists', () => {
  const pool = [mk('single', 'growth')];
  const result = buildAdaptiveQueue('u2', { pool, wordCount: 16 });

  assert.equal(result.queue.length >= 1, true);
});

test('buildAdaptiveQueue returns empty only when no data exists', () => {
  const result = buildAdaptiveQueue('u3', { pool: [], wordCount: 16 });
  assert.equal(Array.isArray(result.queue), true);
  assert.equal(result.queue.length, 0);
  assert.deepEqual(result.targetCounts, { current: 0, stretch: 0, review: 0 });
});

test('buildAdaptiveQueue normalizes custom ratios and keeps unique items', () => {
  const pool = [
    mk('a', 'growth'),
    mk('a', 'growth', { id: 'a-duplicate' }),
    mk('b', 'stretch'),
    mk('c', 'due_review'),
    mk('d', 'growth'),
  ];

  const result = buildAdaptiveQueue('u4', {
    pool,
    wordCount: 4,
    currentPct: 7,
    stretchPct: 2,
    reviewPct: 1,
  });

  const ids = result.queue.map((item) => String(item._id || item.id || item.wordId));
  assert.equal(new Set(ids).size, ids.length);
  const ratioSum = result.ratios.current + result.ratios.stretch + result.ratios.review;
  assert.equal(Math.abs(ratioSum - 1) < 0.00001, true);
  assert.equal(result.ratios.current, 0.7);
  assert.equal(result.ratios.stretch, 0.2);
  assert.equal(result.ratios.review, 0.1);
  assert.equal(result.totalRequested, 4);
});

test('buildAdaptiveQueue accepts 70/20/10 percentage-style inputs', () => {
  const pool = [];
  for (let i = 0; i < 14; i += 1) pool.push(mk(`g-${i}`, 'growth'));
  for (let i = 0; i < 4; i += 1) pool.push(mk(`s-${i}`, 'stretch'));
  for (let i = 0; i < 2; i += 1) pool.push(mk(`r-${i}`, 'due_review'));

  const result = buildAdaptiveQueue('u-pct', {
    pool,
    wordCount: 20,
    currentPct: 70,
    stretchPct: 20,
    reviewPct: 10,
  });

  assert.deepEqual(result.targetCounts, { current: 14, stretch: 4, review: 2 });
  assert.deepEqual(result.counts, { current: 14, stretch: 4, review: 2 });
});

test('buildAdaptiveQueue reports both target and actual composition', () => {
  const pool = [];
  for (let i = 0; i < 8; i += 1) pool.push(mk(`g${i}`, 'growth'));
  for (let i = 0; i < 2; i += 1) pool.push(mk(`s${i}`, 'stretch'));

  const result = buildAdaptiveQueue('u5', { pool, wordCount: 10 });

  assert.deepEqual(result.targetCounts, { current: 7, stretch: 2, review: 1 });
  assert.equal(result.counts.review, 0);
  assert.equal(result.counts.current >= result.targetCounts.current, true);
  assert.equal(result.counts.current + result.counts.stretch + result.counts.review, result.queue.length);
  assert.equal(result.queue.length, 10);
});
