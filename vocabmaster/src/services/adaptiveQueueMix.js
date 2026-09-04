function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizePool(pool) {
  if (!Array.isArray(pool)) return [];
  return pool.filter((item) => item && typeof item === 'object');
}

function normalizeRatios(options = {}) {
  const fallback = { current: 0.7, stretch: 0.2, review: 0.1 };
  const rawInputs = [
    asNumber(options.currentPct, NaN),
    asNumber(options.stretchPct, NaN),
    asNumber(options.reviewPct, NaN),
  ];
  const useWeightedMode = rawInputs.some((value) => Number.isFinite(value) && value > 1);

  const raw = useWeightedMode
    ? {
        current: Math.max(0, asNumber(options.currentPct, fallback.current * 100)),
        stretch: Math.max(0, asNumber(options.stretchPct, fallback.stretch * 100)),
        review: Math.max(0, asNumber(options.reviewPct, fallback.review * 100)),
      }
    : {
        current: clamp(asNumber(options.currentPct, fallback.current), 0, 1, fallback.current),
        stretch: clamp(asNumber(options.stretchPct, fallback.stretch), 0, 1, fallback.stretch),
        review: clamp(asNumber(options.reviewPct, fallback.review), 0, 1, fallback.review),
      };
  const sum = raw.current + raw.stretch + raw.review;
  if (sum <= 0) return fallback;
  return {
    current: Number((raw.current / sum).toFixed(6)),
    stretch: Number((raw.stretch / sum).toFixed(6)),
    review: Number((raw.review / sum).toFixed(6)),
  };
}

function normalizeId(item, index) {
  if (!item || typeof item !== 'object') return `idx:${index}`;
  const id = item._id || item.id || item.wordId || item.queueItemId || null;
  if (!id) return `idx:${index}`;
  return String(id);
}

function isReviewWord(item) {
  const source = String(item?._planMeta?.source || item?.source || '').toLowerCase();
  if (source === 'due_review' || source === 'remediation') return true;
  if (item?._planMeta?.dueReview === true) return true;
  if (item?._planMeta?.struggling === true) return true;
  return false;
}

function isStretchWord(item) {
  const source = String(item?._planMeta?.source || item?.source || '').toLowerCase();
  if (source === 'stretch') return true;
  if (item?._planMeta?.inBand === false) return true;
  return false;
}

function isCurrentBandWord(item) {
  if (isReviewWord(item) || isStretchWord(item)) return false;
  const source = String(item?._planMeta?.source || item?.source || '').toLowerCase();
  if (source === 'growth' || source === 'new' || source === 'review') return true;
  return item?._planMeta?.inBand !== false;
}

function toTakeCount(totalCount, pct) {
  const safeTotal = Math.max(0, Math.floor(asNumber(totalCount, 0)));
  const safePct = clamp(pct, 0, 1, 0);
  return Math.max(0, Math.floor(safeTotal * safePct));
}

function pickWithPredicate(pool, takeCount, predicate, usedIds) {
  const selected = [];
  const seen = usedIds instanceof Set ? usedIds : new Set();
  const wanted = Math.max(0, Math.floor(asNumber(takeCount, 0)));
  if (!wanted) return selected;

  for (let index = 0; index < pool.length; index += 1) {
    if (selected.length >= wanted) break;
    const item = pool[index];
    const id = normalizeId(item, index);
    if (seen.has(id)) continue;
    if (!predicate(item)) continue;
    seen.add(id);
    selected.push(item);
  }

  return selected;
}

function fillFromRemaining(pool, takeCount, usedIds) {
  const selected = [];
  const seen = usedIds instanceof Set ? usedIds : new Set();
  const wanted = Math.max(0, Math.floor(asNumber(takeCount, 0)));
  if (!wanted) return selected;

  for (let index = 0; index < pool.length; index += 1) {
    if (selected.length >= wanted) break;
    const item = pool[index];
    const id = normalizeId(item, index);
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(item);
  }

  return selected;
}

function countQueueComposition(queue = []) {
  const summary = { current: 0, stretch: 0, review: 0 };
  (Array.isArray(queue) ? queue : []).forEach((item) => {
    if (isReviewWord(item)) {
      summary.review += 1;
      return;
    }
    if (isStretchWord(item)) {
      summary.stretch += 1;
      return;
    }
    summary.current += 1;
  });
  return summary;
}

function pickCurrentBandWords(pool, pct, context = {}) {
  const source = normalizePool(pool);
  const usedIds = context.usedIds instanceof Set ? context.usedIds : new Set();
  const totalCount = asNumber(context.totalCount, source.length);
  const takeCount = toTakeCount(totalCount, pct);
  return pickWithPredicate(source, takeCount, isCurrentBandWord, usedIds);
}

function pickStretchWords(pool, pct, context = {}) {
  const source = normalizePool(pool);
  const usedIds = context.usedIds instanceof Set ? context.usedIds : new Set();
  const totalCount = asNumber(context.totalCount, source.length);
  const takeCount = toTakeCount(totalCount, pct);
  return pickWithPredicate(source, takeCount, isStretchWord, usedIds);
}

function pickReviewWords(pool, pct, context = {}) {
  const source = normalizePool(pool);
  const usedIds = context.usedIds instanceof Set ? context.usedIds : new Set();
  const totalCount = asNumber(context.totalCount, source.length);
  const takeCount = toTakeCount(totalCount, pct);
  return pickWithPredicate(source, takeCount, isReviewWord, usedIds);
}

function buildAdaptiveQueue(userId, options = {}) {
  const pool = normalizePool(options.pool);
  if (!pool.length) {
    return {
      userId: String(userId || ''),
      queue: [],
      totalRequested: 0,
      counts: { current: 0, stretch: 0, review: 0 },
      targetCounts: { current: 0, stretch: 0, review: 0 },
      ratios: { current: 0.7, stretch: 0.2, review: 0.1 },
    };
  }

  const totalRequested = Math.max(1, Math.min(Math.floor(asNumber(options.wordCount, 16)), pool.length));
  const ratios = normalizeRatios(options);

  const usedIds = new Set();
  const targetCounts = {
    current: Math.floor(totalRequested * ratios.current),
    stretch: Math.floor(totalRequested * ratios.stretch),
    review: Math.floor(totalRequested * ratios.review),
  };

  const assigned = targetCounts.current + targetCounts.stretch + targetCounts.review;
  let remainder = Math.max(0, totalRequested - assigned);
  while (remainder > 0) {
    targetCounts.current += 1;
    remainder -= 1;
  }

  const review = pickReviewWords(pool, 1, { usedIds, totalCount: targetCounts.review });
  const current = pickCurrentBandWords(pool, 1, { usedIds, totalCount: targetCounts.current });
  const stretch = pickStretchWords(pool, 1, { usedIds, totalCount: targetCounts.stretch });

  let queue = [...review, ...current, ...stretch];
  if (queue.length < totalRequested) {
    const missing = totalRequested - queue.length;
    queue = [...queue, ...fillFromRemaining(pool, missing, usedIds)];
  }

  if (!queue.length && pool.length) {
    queue = [pool[0]];
  }

  const counts = countQueueComposition(queue);

  return {
    userId: String(userId || ''),
    queue,
    totalRequested,
    counts,
    targetCounts,
    ratios,
  };
}

module.exports = {
  buildAdaptiveQueue,
  pickCurrentBandWords,
  pickStretchWords,
  pickReviewWords,
  isCurrentBandWord,
  isStretchWord,
  isReviewWord,
};