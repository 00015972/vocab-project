function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeSubtopic(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

function normalizeWordDifficulty(word) {
  if (Number.isFinite(Number(word?.difficulty))) {
    return clamp(Number(word.difficulty), 1, 5, 3);
  }
  if (Number.isFinite(Number(word?.adaptiveMetrics?.itemDifficulty))) {
    const score = clamp(Number(word.adaptiveMetrics.itemDifficulty), 0, 100, 50);
    return Number((1 + (score / 100) * 4).toFixed(2));
  }
  return 3;
}

function normalizeWordAccuracy(word) {
  const attempts = Math.max(
    0,
    asNumber(word?.adaptiveMetrics?.attempts, asNumber(word?.timesReviewed, 0))
  );
  const correct = Math.max(
    0,
    asNumber(word?.adaptiveMetrics?.correct, asNumber(word?.timesCorrect, 0))
  );
  if (!attempts) return null;
  return clamp((correct / attempts) * 100, 0, 100, 0);
}

function extractWordSubtopics(word) {
  const tags = Array.isArray(word?.tags)
    ? word.tags.map((tag) => normalizeSubtopic(tag)).filter(Boolean)
    : [];
  const domain = normalizeSubtopic(word?.domain);
  const values = new Set(tags);
  // Keep domain as fallback context only after explicit tags.
  if (domain && values.size < 3) values.add(domain);
  return Array.from(values);
}

function buildMiniLesson(subtopic, targetDifficulty, itemCount) {
  const label = subtopic || 'focus area';
  return {
    title: `Mini-lesson: ${label}`,
    objective: `Stabilize ${label} with easier guided retrieval before returning to the main path.`,
    targetDifficulty,
    estimatedMinutes: Math.max(6, Math.min(14, 4 + itemCount)),
    steps: [
      {
        id: 'warmup_recall',
        mode: 'flashcards',
        instruction: `Quick warm-up: recall meaning and usage of ${label} words.`,
        targetAccuracyPct: 65,
      },
      {
        id: 'guided_match',
        mode: 'matching',
        instruction: `Guided pairing on ${label} to reduce confusion and reinforce patterns.`,
        targetAccuracyPct: 70,
      },
      {
        id: 'checkpoint_quiz',
        mode: 'quiz',
        instruction: `Short checkpoint quiz to verify recovery before resuming normal difficulty.`,
        targetAccuracyPct: 75,
      },
    ],
  };
}

function buildRemediationPack(subtopic, targetDifficulty, options = {}) {
  const focusSubtopic = normalizeSubtopic(subtopic);
  const desiredDifficulty = clamp(asNumber(targetDifficulty, 2), 1, 5, 2);
  const maxItems = Math.max(1, Math.floor(asNumber(options.maxItems, 8)));
  const pool = Array.isArray(options.words) ? options.words : [];

  const candidates = pool.filter((word) => {
    if (!word || typeof word !== 'object') return false;
    const status = String(word.learningStatus || '').toLowerCase();
    if (status === 'mastered') return false;
    if (!focusSubtopic) return true;
    const labels = extractWordSubtopics(word);
    return labels.includes(focusSubtopic);
  });

  const ranked = candidates
    .map((word, index) => {
      const difficulty = normalizeWordDifficulty(word);
      const accuracy = normalizeWordAccuracy(word);
      const distance = Math.abs(difficulty - desiredDifficulty);
      const weakness = accuracy === null ? 45 : Math.max(0, 100 - accuracy);
      return {
        word,
        difficulty,
        accuracy,
        distance,
        weakness,
        index,
      };
    })
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (b.weakness !== a.weakness) return b.weakness - a.weakness;
      return a.index - b.index;
    });

  const selected = ranked.slice(0, maxItems).map((entry, idx) => ({
    position: idx,
    wordId: String(entry.word?._id || entry.word?.wordId || entry.word?.id || ''),
    word: String(entry.word?.word || ''),
    definition: String(entry.word?.definition || ''),
    difficulty: Number(entry.difficulty.toFixed(2)),
    accuracyPct: entry.accuracy === null ? null : Number(entry.accuracy.toFixed(2)),
    source: 'remediation_pack',
    subtopic: focusSubtopic,
  }));

  const active = selected.length > 0;
  const reason = active
    ? `Prepared ${selected.length} support items for ${focusSubtopic || 'targeted recovery'} at easier difficulty.`
    : 'No suitable remediation items found for this subtopic.';

  return {
    active,
    subtopic: focusSubtopic,
    targetDifficulty: desiredDifficulty,
    totalCandidates: candidates.length,
    totalSelected: selected.length,
    words: selected,
    miniLesson: buildMiniLesson(focusSubtopic, desiredDifficulty, selected.length),
    reason,
  };
}

module.exports = {
  buildRemediationPack,
};
