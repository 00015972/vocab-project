'use strict';

const assert  = require('assert');
const vm      = require('vm');
const fs      = require('fs');
const path    = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

function loadModule(overrides = {}) {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/adaptiveQueue.js'), 'utf8');

  const ctx = {
    // minimal window/globalThis surface
    globalThis: {},
    URLSearchParams,
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    ...overrides,
  };
  // point globalThis at itself so the IIFE picks it up
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.adaptiveQueue;
}

function makeMockApi({ postResult = null, getResult = null } = {}) {
  const calls = { post: [], get: [], postWithRetry: [] };
  const api = {
    post: async (path, body) => {
      calls.post.push({ path, body });
      if (postResult instanceof Error) throw postResult;
      return postResult;
    },
    get: async (path) => {
      calls.get.push({ path });
      if (getResult instanceof Error) throw getResult;
      return getResult;
    },
    postWithRetry: async (path, body, opts) => {
      calls.postWithRetry.push({ path, body, opts });
      if (postResult instanceof Error) throw postResult;
      return postResult;
    },
  };
  return { api, calls };
}

function makeActiveQueue(overrides = {}) {
  return {
    queueId: 'q-abc123',
    planId:  'p-xyz',
    version: 1,
    status:  'active',
    cursor:  { nextIndex: 0, completedCount: 0 },
    items: [
      { queueItemId: 'item-1', wordId: 'w1', word: 'ephemeral', definition: 'Lasting a very short time.', difficulty: 3, position: 0, status: 'pending', attempts: 0, correctAttempts: 0, behavior: null, source: 'growth' },
      { queueItemId: 'item-2', wordId: 'w2', word: 'ubiquitous', definition: 'Present everywhere.',           difficulty: 4, position: 1, status: 'pending', attempts: 0, correctAttempts: 0, behavior: null, source: 'due_review' },
      { queueItemId: 'item-3', wordId: 'w3', word: 'perspicuous', definition: 'Clearly expressed.',          difficulty: 2, position: 2, status: 'pending', attempts: 0, correctAttempts: 0, behavior: null, source: 'stretch' },
    ],
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

async function run() {

  // ── 1. resolveQueueParams ───────────────────────────────────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '?queueId=q1&planId=p1&mode=quiz&wordCount=12&minutes=25&targetLevel=B1&hearts=4' } });

    const params = aq.resolveQueueParams();
    assert.strictEqual(params.queueId,    'q1');
    assert.strictEqual(params.planId,     'p1');
    assert.strictEqual(params.mode,       'quiz');
    assert.strictEqual(params.wordCount,  12);
    assert.strictEqual(params.minutes,    25);
    assert.strictEqual(params.targetLevel,'B1');
    assert.strictEqual(params.hearts,     4);
  }

  // ── 2. resolveQueueParams — empty search ────────────────────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '' } });

    const params = aq.resolveQueueParams();
    assert.strictEqual(params.queueId, null);
    assert.strictEqual(params.planId,  null);
    assert.strictEqual(params.hearts,  5);
  }

  // ── 3. loadActiveQueue — success ────────────────────────────────────────
  {
    const queue = makeActiveQueue();
    const { api, calls } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    const result = await aq.loadActiveQueue(null);

    assert.strictEqual(result.queueId, 'q-abc123');
    assert.strictEqual(result.planId,  'p-xyz');
    assert.strictEqual(result.totalItems, 3);
    assert.strictEqual(result.items.length, 3);
    assert.strictEqual(calls.get.length, 1);
    assert.ok(calls.get[0].path.includes('/progress/queue/current'));

    // check normalized item shape
    const first = result.items[0];
    assert.strictEqual(first.word, 'ephemeral');
    assert.strictEqual(first.source, 'growth');
    assert.strictEqual(first.queueMeta.queueId, 'q-abc123');
    assert.strictEqual(first.queueMeta.expectedVersion, 1);
    assert.strictEqual(first.queueMeta.expectedPosition, 0);
  }

  // ── 4. loadActiveQueue — queueId validation success ─────────────────────
  {
    const queue = makeActiveQueue({ queueId: 'q-match' });
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    const result = await aq.loadActiveQueue('q-match');
    assert.strictEqual(result.queueId, 'q-match');
  }

  // ── 5. loadActiveQueue — QUEUE_MISMATCH ─────────────────────────────────
  {
    const queue = makeActiveQueue({ queueId: 'q-actual' });
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.loadActiveQueue('q-expected'),
      (err) => {
        assert.strictEqual(err.code, 'QUEUE_MISMATCH');
        assert.strictEqual(err.expected, 'q-expected');
        assert.strictEqual(err.actual, 'q-actual');
        return true;
      }
    );
    // cache cleared on mismatch
    assert.strictEqual(aq.getCachedItems().length, 0, 'cached items should be empty after mismatch');
    assert.strictEqual(aq.getCachedQueue(), null);
  }

  // ── 6. loadActiveQueue — NO_ACTIVE_QUEUE (empty items) ──────────────────
  {
    const { api } = makeMockApi({ getResult: { activeQueue: { queueId: 'q1', items: [] } } });
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.loadActiveQueue(null),
      (err) => { assert.strictEqual(err.code, 'NO_ACTIVE_QUEUE'); return true; }
    );
  }

  // ── 7. loadActiveQueue — NO_ACTIVE_QUEUE (null response) ────────────────
  {
    const { api } = makeMockApi({ getResult: { activeQueue: null } });
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.loadActiveQueue(null),
      (err) => { assert.strictEqual(err.code, 'NO_ACTIVE_QUEUE'); return true; }
    );
  }

  // ── 8. loadPlanQueue — success + verifies prefs sent to POST ────────────
  {
    const queue = makeActiveQueue();
    const startPayload = { queueId: 'q-abc123', planId: 'p-xyz', totalItems: 3 };

    let postedBody = null;
    let getCallCount = 0;
    const api = {
      post: async (path, body) => { postedBody = body; return startPayload; },
      get:  async () => { getCallCount++; return { activeQueue: queue }; },
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '?wordCount=8&minutes=20&mode=flashcards&hearts=3' } });

    const result = await aq.loadPlanQueue(null);

    assert.strictEqual(result.queueId, 'q-abc123');
    assert.strictEqual(result.planId,  'p-xyz');
    assert.strictEqual(result.totalItems, 3);
    assert.strictEqual(getCallCount, 1);
    // prefs from URL params must reach the POST body
    assert.strictEqual(postedBody.wordCount, 8,           'wordCount should come from URL param');
    assert.strictEqual(postedBody.minutes,   20,          'minutes should come from URL param');
    assert.strictEqual(postedBody.mode,      'flashcards','mode should come from URL param');
    assert.strictEqual(postedBody.hearts,    3,           'hearts should come from URL param');
  }

  // ── 9. loadPlanQueue — planId mismatch is a warning not an error ─────────
  {
    const queue = makeActiveQueue({ planId: 'p-new' });
    const api = {
      post: async () => ({ queueId: 'q-abc123', planId: 'p-new' }),
      get:  async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });

    // should not throw even though planIdHint differs from returned planId
    const result = await aq.loadPlanQueue('p-old-hint');
    assert.strictEqual(result.queueId, 'q-abc123');
  }

  // ── 10. loadPlanQueue — QUEUE_MISMATCH between start and current ─────────
  {
    const startPayload = { queueId: 'q-start' };
    const queue = makeActiveQueue({ queueId: 'q-different' });
    const api = {
      post: async () => startPayload,
      get:  async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.loadPlanQueue(null),
      (err) => { assert.strictEqual(err.code, 'QUEUE_MISMATCH'); return true; }
    );
  }

  // ── 11. loadPlanQueue — queue/start returns no queueId ───────────────────
  {
    const { api } = makeMockApi({ postResult: { message: 'ok' } }); // no queueId
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.loadPlanQueue(null),
      /loadPlanQueue: queue\/start returned no queueId/
    );
  }

  // ── 12. consumeQueueItem — success ───────────────────────────────────────
  {
    const queue = makeActiveQueue();
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    await aq.loadActiveQueue(null);

    const item0 = aq.consumeQueueItem('q-abc123', 0);
    assert.ok(item0 !== null);
    assert.strictEqual(item0.word, 'ephemeral');
    assert.strictEqual(item0.position, 0);

    const item1 = aq.consumeQueueItem('q-abc123', 1);
    assert.strictEqual(item1.word, 'ubiquitous');
    assert.strictEqual(item1.source, 'due_review');
  }

  // ── 13. consumeQueueItem — out of bounds returns null ────────────────────
  {
    const queue = makeActiveQueue();
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    await aq.loadActiveQueue(null);

    assert.strictEqual(aq.consumeQueueItem('q-abc123', 99), null);
    // negative index clamps to 0 — item 0 exists, so returns it not null
    assert.ok(aq.consumeQueueItem('q-abc123', -1) !== null, 'negative index should clamp to 0 and return first item');
    // exactly at length returns null
    assert.strictEqual(aq.consumeQueueItem('q-abc123', 3), null, 'index === length should be out of bounds');
  }

  // ── 14. consumeQueueItem — queueId mismatch returns null ─────────────────
  {
    const queue = makeActiveQueue({ queueId: 'q-real' });
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    await aq.loadActiveQueue(null);

    assert.strictEqual(aq.consumeQueueItem('q-wrong', 0), null);
  }

  // ── 15. consumeQueueItem — no queue loaded returns null ──────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '' } });
    // no loadActiveQueue called yet
    assert.strictEqual(aq.consumeQueueItem('q-abc', 0), null);
  }

  // ── 16. submitAttempt — success ──────────────────────────────────────────
  {
    const { api, calls } = makeMockApi({ postResult: { accepted: true } });
    const aq = loadModule({ api, location: { search: '' } });

    const payload = { queueItemId: 'item-1', mode: 'flashcards', correctness: true, latencyMs: 1400, expectedVersion: 2, expectedPosition: 0 };
    const result = await aq.submitAttempt('q-abc123', payload);

    assert.strictEqual(calls.postWithRetry.length, 1);
    const sent = calls.postWithRetry[0];
    assert.strictEqual(sent.path, '/progress/queue/attempt');
    assert.strictEqual(sent.body.queueId, 'q-abc123');
    assert.strictEqual(sent.body.queueItemId, 'item-1');
    assert.strictEqual(sent.body.mode, 'flashcards');
    assert.strictEqual(sent.body.correctness, true);
    assert.strictEqual(sent.body.latencyMs, 1400);
    assert.strictEqual(sent.body.expectedVersion, 2);
    assert.strictEqual(sent.body.expectedPosition, 0);
    assert.ok(typeof sent.body.idempotencyKey === 'string' && sent.body.idempotencyKey.length > 5, 'idempotencyKey should be auto-generated');
    assert.ok(result && result.accepted);
  }

  // ── 17. submitAttempt — correctness coercion ─────────────────────────────
  {
    const { api, calls } = makeMockApi({ postResult: { accepted: true } });
    const aq = loadModule({ api, location: { search: '' } });

    await aq.submitAttempt('q-1', { queueItemId: 'i-1', correctness: 'false', latencyMs: 3000 });
    assert.strictEqual(calls.postWithRetry[0].body.correctness, false, 'string "false" should coerce to boolean false');

    await aq.submitAttempt('q-1', { queueItemId: 'i-1', correctness: 1, latencyMs: 1000 });
    assert.strictEqual(calls.postWithRetry[1].body.correctness, true, 'truthy 1 should coerce to true');
  }

  // ── 18. submitAttempt — missing queueId throws ───────────────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(
      () => aq.submitAttempt(null, { queueItemId: 'i-1' }),
      /queueId and payload.queueItemId are required/
    );
    await assert.rejects(
      () => aq.submitAttempt('q-1', { queueItemId: null }),
      /queueId and payload.queueItemId are required/
    );
  }

  // ── 19. submitAttempt — no expectedVersion omits it ──────────────────────
  {
    const { api, calls } = makeMockApi({ postResult: { accepted: true } });
    const aq = loadModule({ api, location: { search: '' } });

    await aq.submitAttempt('q-1', { queueItemId: 'i-1', correctness: true, latencyMs: 800 });
    const sent = calls.postWithRetry[0].body;
    assert.ok(!Object.prototype.hasOwnProperty.call(sent, 'expectedVersion'), 'expectedVersion should be omitted when not provided');
  }

  // ── 20. getCachedItems / getCachedQueue ───────────────────────────────────
  {
    const queue = makeActiveQueue();
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });

    assert.strictEqual(aq.getCachedItems().length, 0, 'items should be empty before load');
    assert.strictEqual(aq.getCachedQueue(), null);

    await aq.loadActiveQueue(null);

    assert.strictEqual(aq.getCachedItems().length, 3);
    assert.strictEqual(aq.getCachedQueue().queueId, 'q-abc123');
    // getCachedItems returns a new array (shallow copy) — pushing to it does NOT affect the internal list
    const copy = aq.getCachedItems();
    copy.push({ word: 'ADDED' });
    assert.strictEqual(aq.getCachedItems().length, 3, 'internal array should be unaffected by push to returned copy');
  }

  console.log('adaptiveQueue unit tests passed');
}

// ── extra tests added during recheck ────────────────────────────────────────

async function runRecheck() {

  // ── 21. resolveQueueParams — hearts=0 must not default to 5 ─────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '?hearts=0' } });
    const params = aq.resolveQueueParams();
    assert.strictEqual(params.hearts, 0, 'hearts=0 in URL must resolve to 0, not 5');
  }

  // ── 22. resolveQueueParams — hearts absent defaults to 5 ─────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '' } });
    assert.strictEqual(aq.resolveQueueParams().hearts, 5, 'absent hearts param should default to 5');
  }

  // ── 23. loadActiveQueue — network error propagates, cache cleared ─────────
  {
    const networkErr = new Error('Network failure');
    const { api } = makeMockApi({ getResult: networkErr });
    const aq = loadModule({ api, location: { search: '' } });

    await assert.rejects(() => aq.loadActiveQueue(null), /Network failure/);
    // cache must be clean even though the API threw mid-call
    assert.strictEqual(aq.getCachedItems().length, 0, 'cache must be empty after a thrown network error');
    assert.strictEqual(aq.getCachedQueue(), null);
  }

  // ── 24. loadPlanQueue — cache is clean after mid-flight failure ───────────
  {
    // Stage 1: successfully load a queue so the cache is populated
    const firstQueue = makeActiveQueue({ queueId: 'q-first' });
    const api1 = { post: async () => {}, get: async () => ({ activeQueue: firstQueue }), postWithRetry: async () => {} };
    const aq = loadModule({ api1, location: { search: '' } });
    // Manually boot via a different module instance is not possible since ctx is isolated;
    // instead, we test the fresh module directly: start fails → cache stays empty
    const startErr = new Error('Server error');
    const api2 = { post: async () => { throw startErr; }, get: async () => {}, postWithRetry: async () => {} };
    const aq2 = loadModule({ api: api2, location: { search: '' } });
    await assert.rejects(() => aq2.loadPlanQueue(null), /Server error/);
    assert.strictEqual(aq2.getCachedItems().length, 0, 'cache must be empty when queue/start throws');
    assert.strictEqual(aq2.getCachedQueue(), null);
  }

  // ── 25. loadPlanQueue — cache clean when queue/current throws ────────────
  {
    let calls = 0;
    const api = {
      post: async () => ({ queueId: 'q-started' }),
      get:  async () => { calls++; throw new Error('current failed'); },
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    await assert.rejects(() => aq.loadPlanQueue(null), /current failed/);
    assert.strictEqual(aq.getCachedItems().length, 0, 'cache must be empty when queue/current throws');
    assert.strictEqual(aq.getCachedQueue(), null);
  }

  // ── 26. getCachedCursor — no queue loaded returns zeros ──────────────────
  {
    const { api } = makeMockApi();
    const aq = loadModule({ api, location: { search: '' } });
    const cursor = aq.getCachedCursor();
    assert.strictEqual(cursor.nextIndex, 0);
    assert.strictEqual(cursor.completedCount, 0);
  }

  // ── 27. getCachedCursor — reflects loaded queue cursor ───────────────────
  {
    const queue = makeActiveQueue({ cursor: { nextIndex: 2, completedCount: 2 } });
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);
    const cursor = aq.getCachedCursor();
    assert.strictEqual(cursor.nextIndex, 2);
    assert.strictEqual(cursor.completedCount, 2);
  }

  // ── 28. consumeQueueItem — uses cursor index after load ───────────────────
  {
    const queue = makeActiveQueue({ cursor: { nextIndex: 1, completedCount: 1 } });
    const { api } = makeMockApi({ getResult: { activeQueue: queue } });
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);

    const cursor = aq.getCachedCursor();
    const item = aq.consumeQueueItem(queue.queueId, cursor.nextIndex);
    assert.ok(item !== null);
    assert.strictEqual(item.word, 'ubiquitous', 'item at cursor.nextIndex=1 should be the second word');
  }

  // ── 31. onQueueComplete — progress saved, allConsumed from caller ─────────
  {
    const queue = makeActiveQueue();
    let postCalls = [];
    const api = {
      post:          async (path, body) => { postCalls.push({ path, body }); return { message: 'ok', gamification: null }; },
      get:           async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);

    const result = await aq.onQueueComplete('q-abc123', {
      sessionType: 'flashcards', xpEarned: 120, accuracy: 85, wordsCompleted: 3,
      durationSeconds: 180, allConsumed: true,
    });

    assert.strictEqual(result.progressSaved, true);
    assert.strictEqual(result.queueAbandoned, false, 'should NOT abandon when allConsumed=true');
    assert.strictEqual(result.allConsumed, true);
    const progressCall = postCalls.find((c) => c.path === '/progress');
    assert.ok(progressCall, '/progress should have been called');
    assert.strictEqual(progressCall.body.sessionType, 'flashcards');
    assert.strictEqual(progressCall.body.xpEarned, 120);
    assert.strictEqual(progressCall.body.accuracy, 85);
    // no abandon call
    const abandonCall = postCalls.find((c) => c.path.includes('abandon'));
    assert.ok(!abandonCall, '/progress/queue/abandon should NOT be called when allConsumed=true');
  }

  // ── 32. onQueueComplete — queue abandoned when allConsumed=false ──────────
  {
    const queue = makeActiveQueue();
    let postCalls = [];
    const api = {
      post:          async (path, body) => { postCalls.push({ path, body }); return { message: 'ok' }; },
      get:           async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);

    const result = await aq.onQueueComplete('q-abc123', {
      sessionType: 'quiz', xpEarned: 40, accuracy: 30, wordsCompleted: 1,
      durationSeconds: 60, allConsumed: false,
    });

    assert.strictEqual(result.allConsumed, false);
    assert.strictEqual(result.queueAbandoned, true, 'should abandon when allConsumed=false');
    const abandonCall = postCalls.find((c) => c.path.includes('abandon'));
    assert.ok(abandonCall, '/progress/queue/abandon should be called when allConsumed=false');
  }

  // ── 33. onQueueComplete — allConsumed from cursor when not in summary ─────
  {
    // Queue with cursor.completedCount === items.length → allConsumed=true
    const queue = makeActiveQueue({ cursor: { nextIndex: 3, completedCount: 3 } });
    let postCalls = [];
    const api = {
      post:          async (path) => { postCalls.push(path); return { message: 'ok' }; },
      get:           async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);

    // no allConsumed in summary → fallback to cursor check
    const result = await aq.onQueueComplete('q-abc123', {
      sessionType: 'matching', xpEarned: 80, accuracy: 100, wordsCompleted: 3, durationSeconds: 90,
    });

    assert.strictEqual(result.allConsumed, true, 'cursor completedCount===totalItems should set allConsumed=true');
    const abandonCalled = postCalls.some((p) => String(p).includes('abandon'));
    assert.strictEqual(abandonCalled, false, 'should not abandon when cursor says all consumed');
  }

  // ── 34. onQueueComplete — progress save failure is non-fatal ─────────────
  {
    const queue = makeActiveQueue();
    const api = {
      post:          async (path) => { throw new Error('Network error'); },
      get:           async () => ({ activeQueue: queue }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    await aq.loadActiveQueue(null);

    const result = await aq.onQueueComplete('q-abc123', {
      sessionType: 'spelling', xpEarned: 0, accuracy: 0, wordsCompleted: 0,
      durationSeconds: 10, allConsumed: true,
    });

    assert.strictEqual(result.progressSaved, false);
    assert.ok(result.progressError, 'progressError should be set on failure');
    // should not throw
  }

  // ── 35. onQueueComplete — works without a loaded queue (null queueId) ─────
  {
    let postCalls = [];
    const api = {
      post:          async (path, body) => { postCalls.push({ path, body }); return { message: 'ok' }; },
      get:           async () => ({ activeQueue: null }),
      postWithRetry: async () => {},
    };
    const aq = loadModule({ api, location: { search: '' } });
    // no loadActiveQueue called

    const result = await aq.onQueueComplete(null, {
      sessionType: 'flashcards', xpEarned: 50, accuracy: 70, wordsCompleted: 3,
      durationSeconds: 30, allConsumed: true,
    });

    assert.strictEqual(result.progressSaved, true);
    assert.strictEqual(result.queueAbandoned, false, 'no queueId means no abandon call');
    assert.strictEqual(postCalls.filter((c) => c.path === '/progress').length, 1);
    assert.strictEqual(postCalls.filter((c) => c.path.includes('abandon')).length, 0);
  }

  // ── 29. submitAttempt — latencyMs defaults to 0 when omitted ─────────────
  {
    const { api, calls } = makeMockApi({ postResult: { accepted: true } });
    const aq = loadModule({ api, location: { search: '' } });
    await aq.submitAttempt('q-1', { queueItemId: 'i-1', correctness: false });
    assert.strictEqual(calls.postWithRetry[0].body.latencyMs, 0);
  }

  // ── 30. submitAttempt — idempotencyKey is unique across calls ────────────
  {
    const { api, calls } = makeMockApi({ postResult: { accepted: true } });
    const aq = loadModule({ api, location: { search: '' } });
    await aq.submitAttempt('q-1', { queueItemId: 'i-1', correctness: true, latencyMs: 500 });
    await aq.submitAttempt('q-1', { queueItemId: 'i-2', correctness: false, latencyMs: 600 });
    const key1 = calls.postWithRetry[0].body.idempotencyKey;
    const key2 = calls.postWithRetry[1].body.idempotencyKey;
    assert.notStrictEqual(key1, key2, 'each submitAttempt call must produce a unique idempotencyKey');
  }

  console.log('adaptiveQueue recheck tests passed');
}

run()
  .then(() => runRecheck())
  .catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
