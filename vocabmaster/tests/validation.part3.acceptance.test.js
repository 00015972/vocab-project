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
  return {
    users: [
      { _id: 'student-1', role: 'student', linkedCreatorCode: 'CREAT01' },
    ],
    words: [],
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

  try {
    await fn();
  } finally {
    devStore.readStore = original.readStore;
    devStore.getProgressByUser = original.getProgressByUser;
    devStore.saveProgress = original.saveProgress;
  }
}

test('Part3: progress totals update after each session save', async () => {
  const store = makeStore();
  const saveProgressHandler = getRouteHandler('post', '/');

  await withMockedDevStore(store, async () => {
    const req1 = {
      user: { id: 'student-1' },
      body: {
        sessionType: 'flashcards',
        xpEarned: 100,
        accuracy: 80,
        wordsCompleted: 5,
        duration: 60,
        attempts: [
          { correctness: true, latencyMs: 1400 },
          { correctness: false, latencyMs: 2600 },
        ],
      },
    };
    const res1 = createRes();
    await saveProgressHandler(req1, res1);

    assert.equal(res1.statusCode, 200);

    const req2 = {
      user: { id: 'student-1' },
      body: {
        sessionType: 'quiz',
        xpEarned: 50,
        accuracy: 60,
        wordsCompleted: 2,
        duration: 30,
        attempts: [
          { correctness: false, latencyMs: 500 },
          { correctness: false, latencyMs: 4200 },
          { correctness: true, latencyMs: 1700 },
        ],
      },
    };
    const res2 = createRes();
    await saveProgressHandler(req2, res2);

    assert.equal(res2.statusCode, 200);

    const saved = store.progress.find((entry) => String(entry.userId) === 'student-1');
    assert.ok(saved);
    assert.equal(saved.totalXP, 150);
    assert.equal(saved.lessonsCompleted, 2);
    assert.equal(saved.wordsLearned, 7);
    assert.equal(saved.totalStudyTime, 90);
    assert.equal(saved.accuracy, 70);
    assert.equal(Array.isArray(saved.completedLessons), true);
    assert.equal(saved.completedLessons.length, 2);
    assert.equal(Array.isArray(saved.dailyHistory), true);
    assert.equal(saved.dailyHistory.length >= 1, true);
    assert.equal(saved.dailyHistory[0].sessionsCompleted, 2);
    assert.equal(saved.dailyHistory[0].xpEarned, 150);
    assert.equal(saved.dailyHistory[0].wordsLearned, 7);
  });
});

test('Part3: recommendations update after new session outcomes', async () => {
  const store = makeStore();
  const saveProgressHandler = getRouteHandler('post', '/');
  const drilldownHandler = getRouteHandler('get', '/drilldown');

  await withMockedDevStore(store, async () => {
    const firstSessionReq = {
      user: { id: 'student-1' },
      body: {
        sessionType: 'quiz',
        xpEarned: 30,
        accuracy: 95,
        wordsCompleted: 4,
        duration: 40,
        attempts: [{ correctness: true, latencyMs: 1300 }],
      },
    };
    const firstSessionRes = createRes();
    await saveProgressHandler(firstSessionReq, firstSessionRes);
    assert.equal(firstSessionRes.statusCode, 200);

    const beforeReq = { user: { id: 'student-1' }, query: { days: '30' } };
    const beforeRes = createRes();
    await drilldownHandler(beforeReq, beforeRes);

    assert.equal(beforeRes.statusCode, 200);
    const beforeQuizGap = (beforeRes.payload.skillGaps || []).find((gap) => gap.type === 'quiz');
    assert.ok(beforeQuizGap, 'expected initial quiz recommendation');
    assert.match(beforeQuizGap.recommendation, /Increase quiz practice frequency/i);

    const secondSessionReq = {
      user: { id: 'student-1' },
      body: {
        sessionType: 'quiz',
        xpEarned: 15,
        accuracy: 20,
        wordsCompleted: 3,
        duration: 35,
        attempts: [
          { correctness: false, latencyMs: 400 },
          { correctness: false, latencyMs: 3800 },
        ],
      },
    };
    const secondSessionRes = createRes();
    await saveProgressHandler(secondSessionReq, secondSessionRes);
    assert.equal(secondSessionRes.statusCode, 200);

    const afterReq = { user: { id: 'student-1' }, query: { days: '30' } };
    const afterRes = createRes();
    await drilldownHandler(afterReq, afterRes);

    assert.equal(afterRes.statusCode, 200);
    const afterQuizGap = (afterRes.payload.skillGaps || []).find((gap) => gap.type === 'quiz');
    assert.ok(afterQuizGap, 'expected updated quiz recommendation');
    assert.match(afterQuizGap.recommendation, /Practice more quiz sessions and review missed items/i);
    assert.equal(afterQuizGap.avgAccuracy < 75, true);
  });
});
