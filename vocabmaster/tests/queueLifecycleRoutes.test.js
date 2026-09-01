const test = require('node:test');
const assert = require('node:assert/strict');

const progressRouter = require('../src/routes/progress');
const devStore = require('../src/services/devStore');

function getRouteHandler(method, path) {
  const layer = progressRouter.stack.find((entry) => entry.route
    && entry.route.path === path
    && entry.route.methods
    && entry.route.methods[method]);
  if (!layer || !Array.isArray(layer.route.stack) || !layer.route.stack.length) {
    throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeStore() {
  const creator = { _id: 'creator-1', role: 'creator', creatorCode: 'CREAT01' };
  const student = { _id: 'student-1', role: 'student', linkedCreatorCode: 'CREAT01' };
  const words = [];

  for (let i = 0; i < 14; i += 1) {
    words.push({
      _id: `current-${i}`,
      userId: creator._id,
      word: `current-${i}`,
      definition: `definition-current-${i}`,
      difficulty: 2,
      timesReviewed: 0,
      timesCorrect: 0,
      learningStatus: 'locked',
      adaptiveMetrics: { attempts: 0, correct: 0, itemDifficulty: 20 },
    });
  }

  for (let i = 0; i < 4; i += 1) {
    words.push({
      _id: `stretch-${i}`,
      userId: creator._id,
      word: `stretch-${i}`,
      definition: `definition-stretch-${i}`,
      difficulty: 5,
      timesReviewed: 5,
      timesCorrect: 4,
      learningStatus: 'mastered',
      adaptiveMetrics: { attempts: 5, correct: 4, itemDifficulty: 95 },
    });
  }

  for (let i = 0; i < 2; i += 1) {
    words.push({
      _id: `review-${i}`,
      userId: creator._id,
      word: `review-${i}`,
      definition: `definition-review-${i}`,
      difficulty: 3,
      timesReviewed: 6,
      timesCorrect: 3,
      learningStatus: 'review',
      adaptiveMetrics: {
        attempts: 6,
        correct: 3,
        itemDifficulty: 55,
        dueAt: '2020-01-01T00:00:00.000Z',
      },
    });
  }

  return {
    users: [creator, student],
    words,
    progress: [],
    decks: [],
    adminAudit: [],
    goals: [],
    alerts: [],
  };
}

async function withMockedDevStore(store, fn) {
  const original = {
    readStore: devStore.readStore,
    getProgressByUser: devStore.getProgressByUser,
    saveProgress: devStore.saveProgress,
    findWordById: devStore.findWordById,
    findWordByIdForUser: devStore.findWordByIdForUser,
    updateWordGlobal: devStore.updateWordGlobal,
    updateWord: devStore.updateWord,
  };

  devStore.readStore = () => store;
  devStore.getProgressByUser = (userId) => store.progress.find((entry) => String(entry.userId) === String(userId)) || null;
  devStore.saveProgress = (userId, progress) => {
    const next = clone({ ...progress, userId: String(userId) });
    const index = store.progress.findIndex((entry) => String(entry.userId) === String(userId));
    if (index >= 0) store.progress[index] = next;
    else store.progress.push(next);
    return store.progress[index >= 0 ? index : store.progress.length - 1];
  };
  devStore.findWordById = (wordId) => store.words.find((entry) => String(entry._id) === String(wordId)) || null;
  devStore.findWordByIdForUser = (wordId, userId) => store.words.find((entry) => String(entry._id) === String(wordId) && String(entry.userId) === String(userId)) || null;
  devStore.updateWordGlobal = (wordId, payload) => {
    const word = store.words.find((entry) => String(entry._id) === String(wordId));
    if (!word) return null;
    Object.assign(word, payload);
    return word;
  };
  devStore.updateWord = (wordId, userId, payload) => {
    const word = store.words.find((entry) => String(entry._id) === String(wordId) && String(entry.userId) === String(userId));
    if (!word) return null;
    Object.assign(word, payload);
    return word;
  };

  try {
    await fn();
  } finally {
    devStore.readStore = original.readStore;
    devStore.getProgressByUser = original.getProgressByUser;
    devStore.saveProgress = original.saveProgress;
    devStore.findWordById = original.findWordById;
    devStore.findWordByIdForUser = original.findWordByIdForUser;
    devStore.updateWordGlobal = original.updateWordGlobal;
    devStore.updateWord = original.updateWord;
  }
}

test('queue/start persists adaptive mix telemetry and queue/next serves first item', async () => {
  const store = makeStore();
  const startHandler = getRouteHandler('post', '/queue/start');
  const nextHandler = getRouteHandler('get', '/queue/next');

  await withMockedDevStore(store, async () => {
    const startReq = {
      user: { id: 'student-1' },
      body: { minutes: 20, wordCount: 20, hearts: 5, targetLevel: 'AUTO' },
    };
    const startRes = createRes();
    await startHandler(startReq, startRes);

    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.payload.totalItems, 20);
    assert.deepEqual(startRes.payload.mix.targetCounts, { current: 14, stretch: 4, review: 2 });
    assert.equal(startRes.payload.mix.totalRequested, 20);
    assert.equal(startRes.payload.mix.counts.review, 2);
    assert.deepEqual(startRes.payload.settings.difficultyBand, {
      min: 1,
      max: 2,
      label: 'A1 Beginner',
      level: 'A1',
    });
    assert.equal(
      startRes.payload.mix.counts.current + startRes.payload.mix.counts.stretch + startRes.payload.mix.counts.review,
      20
    );

    const saved = store.progress.find((entry) => entry.userId === 'student-1');
    assert.ok(saved);
    assert.equal(saved.adaptiveQueue.targetWords, 20);
    assert.deepEqual(saved.adaptiveQueue.mix.targetCounts, { current: 14, stretch: 4, review: 2 });
    assert.equal(saved.adaptiveQueue.mix.totalRequested, 20);
    assert.equal(saved.adaptiveQueue.mix.counts.review, 2);
    assert.equal(Array.isArray(saved.adaptiveQueue.queuePreview), true);
    assert.equal(saved.adaptiveQueue.queuePreview.length > 0, true);
    assert.equal(saved.adaptiveQueue.queuePreview[0].position, 0);

    const nextReq = { user: { id: 'student-1' }, query: {} };
    const nextRes = createRes();
    await nextHandler(nextReq, nextRes);

    assert.equal(nextRes.statusCode, 200);
    assert.equal(nextRes.payload.nextIndex, 0);
    assert.ok(nextRes.payload.item);
    assert.equal(typeof nextRes.payload.item.queueItemId, 'string');
  });
});

test('queue/attempt is idempotent and advances cursor exactly once', async () => {
  const store = makeStore();
  const startHandler = getRouteHandler('post', '/queue/start');
  const attemptHandler = getRouteHandler('post', '/queue/attempt');

  await withMockedDevStore(store, async () => {
    const startReq = {
      user: { id: 'student-1' },
      body: { minutes: 20, wordCount: 10, hearts: 5, targetLevel: 'AUTO' },
    };
    const startRes = createRes();
    await startHandler(startReq, startRes);

    const activeQueue = store.progress[0]?.adaptiveQueue?.activeQueue;
    assert.ok(activeQueue);

    const firstItem = activeQueue.items[0];
    assert.ok(firstItem);

    const attemptReq = {
      user: { id: 'student-1' },
      body: {
        queueId: activeQueue.queueId,
        queueItemId: firstItem.queueItemId,
        mode: 'flashcards',
        correctness: false,
        latencyMs: 350,
        idempotencyKey: 'idem-1',
        expectedVersion: 1,
        expectedPosition: 0,
      },
    };

    const firstAttemptRes = createRes();
    await attemptHandler(attemptReq, firstAttemptRes);

    assert.equal(firstAttemptRes.statusCode, 200);
    assert.equal(firstAttemptRes.payload.accepted, true);
    assert.equal(firstAttemptRes.payload.replay, undefined);
    assert.equal(firstAttemptRes.payload.activeQueue.cursor.nextIndex, 1);
    assert.equal(firstAttemptRes.payload.activeQueue.cursor.completedCount, 1);
    assert.equal(firstAttemptRes.payload.activeQueue.version, 2);
    assert.equal(firstAttemptRes.payload.activeQueue.attemptLedger.length, 1);
    assert.equal(firstAttemptRes.payload.activeQueue.items.length, 11);

    const replayRes = createRes();
    await attemptHandler(attemptReq, replayRes);

    assert.equal(replayRes.statusCode, 200);
    assert.equal(replayRes.payload.replay, true);
    assert.equal(replayRes.payload.entry.idempotencyKey, 'idem-1');

    const persisted = store.progress[0].adaptiveQueue.activeQueue;
    assert.equal(persisted.cursor.nextIndex, 1);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.attemptLedger.length, 1);
  });
});

test('wrong queue items reappear at increasing spaced intervals', async () => {
  const store = makeStore();
  const startHandler = getRouteHandler('post', '/queue/start');
  const attemptHandler = getRouteHandler('post', '/queue/attempt');

  await withMockedDevStore(store, async () => {
    const startReq = {
      user: { id: 'student-1' },
      body: { minutes: 20, wordCount: 10, hearts: 5, targetLevel: 'AUTO' },
    };
    const startRes = createRes();
    await startHandler(startReq, startRes);

    assert.equal(startRes.statusCode, 200);

    const targetWordId = String(store.progress[0].adaptiveQueue.activeQueue.items[0].wordId);
    const seenTargetAtTurns = [];
    let turn = 0;

    for (let safety = 0; safety < 40 && seenTargetAtTurns.length < 4; safety += 1) {
      const active = store.progress[0].adaptiveQueue.activeQueue;
      const idx = Number(active.cursor?.nextIndex || 0);
      const item = active.items[idx];
      assert.ok(item, 'expected a queue item at cursor');

      const isTarget = String(item.wordId) === targetWordId;
      if (isTarget) seenTargetAtTurns.push(turn);

      const req = {
        user: { id: 'student-1' },
        body: {
          queueId: active.queueId,
          queueItemId: item.queueItemId,
          mode: 'flashcards',
          correctness: isTarget ? false : true,
          latencyMs: 1200,
          idempotencyKey: `gap-${turn}`,
          expectedVersion: active.version,
          expectedPosition: idx,
        },
      };
      const res = createRes();
      await attemptHandler(req, res);
      assert.equal(res.statusCode, 200);
      turn += 1;
    }

    assert.equal(seenTargetAtTurns.length >= 3, true, 'expected at least three target appearances');
    const firstGap = seenTargetAtTurns[1] - seenTargetAtTurns[0];
    const secondGap = seenTargetAtTurns[2] - seenTargetAtTurns[1];
    assert.equal(secondGap > firstGap, true, `expected increasing retry spacing, got first=${firstGap}, second=${secondGap}`);
  });
});
