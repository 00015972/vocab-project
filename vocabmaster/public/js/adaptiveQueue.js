/**
 * adaptiveQueue.js — shared adaptive queue module for all exercise pages.
 *
 * Depends on: `api` global (from api.js, loaded before this script).
 *
 * Exposes window.adaptiveQueue with:
 *   resolveQueueParams()
 *   loadPlanQueue(planIdHint)
 *   loadActiveQueue(queueIdHint)
 *   consumeQueueItem(queueId, index)
 *   submitAttempt(queueId, payload)
 *   getCachedItems()
 *   getCachedQueue()
 */
(function (root, getApiGlobal) {
  'use strict';

  // ── in-memory cache ─────────────────────────────────────────────────────
  var _activeQueue = null;
  var _queueItems = [];

  // ── API access (lazy so tests can inject before calling) ─────────────────
  function _api() {
    var resolved = getApiGlobal();
    if (!resolved) throw new Error('adaptiveQueue: api helper not loaded');
    return resolved;
  }

  // ── normalizeCorrectness ─────────────────────────────────────────────────
  // Mirrors the backend behaviorAnalytics.normalizeCorrectness so string
  // values like "false" or "TRUE" are handled consistently.
  function _normalizeCorrectness(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      var t = value.trim().toLowerCase();
      if (t === 'true' || t === '1' || t === 'yes' || t === 'correct') return true;
      if (t === 'false' || t === '0' || t === 'no' || t === 'incorrect' || t === 'wrong') return false;
    }
    return !!value;
  }

  // ── resolveQueueParams ───────────────────────────────────────────────────
  /**
   * Reads adaptive queue URL parameters.
   * @returns {{ queueId, planId, mode, wordCount, minutes, targetLevel, hearts }}
   */
  function resolveQueueParams() {
    var search = (root && root.location && root.location.search) ? root.location.search : '';
    var params = new URLSearchParams(search);
    var queueId = (params.get('queueId') || '').trim() || null;
    var planId   = (params.get('planId')  || '').trim() || null;
    var mode     = (params.get('mode')    || '').trim().toLowerCase() || null;
    var wordCount = Math.max(0, parseInt(params.get('wordCount'), 10) || 0);
    var minutes   = Math.max(0, parseInt(params.get('minutes'),   10) || 0);
    var targetLevel = (params.get('targetLevel') || '').trim().toUpperCase() || null;
    // FIX: parseInt('0') || 5 would give 5, so we must use isNaN to detect absence
    var heartsRaw = parseInt(params.get('hearts'), 10);
    var hearts = Number.isNaN(heartsRaw) ? 5 : Math.max(0, Math.min(5, heartsRaw));
    return { queueId: queueId, planId: planId, mode: mode, wordCount: wordCount, minutes: minutes, targetLevel: targetLevel, hearts: hearts };
  }

  // ── normalizeQueueItem ───────────────────────────────────────────────────
  function _normalizeItem(raw, queueId, queueVersion) {
    if (!raw || typeof raw !== 'object') return null;
    var pos = Number(raw.position || 0);
    return {
      queueItemId:   String(raw.queueItemId || ''),
      wordId:        String(raw.wordId || raw._id || ''),
      word:          String(raw.word || ''),
      definition:    String(raw.definition || ''),
      hint:          String(raw.hint || raw.example || raw.definition || ''),
      imageUrl:      String(raw.imageUrl || ''),
      difficulty:    Math.max(1, Math.min(5, Number(raw.difficulty || 3))),
      source:        String(raw.source || 'general'),
      status:        String(raw.status || 'pending'),
      position:      pos,
      attempts:      Number(raw.attempts || 0),
      correctAttempts: Number(raw.correctAttempts || 0),
      behavior:      raw.behavior || null,
      queueMeta: {
        queueId:          String(queueId || ''),
        queueItemId:      String(raw.queueItemId || ''),
        expectedVersion:  Number(queueVersion || 1),
        expectedPosition: pos,
      },
    };
  }

  // ── loadPlanQueue ────────────────────────────────────────────────────────
  /**
   * Start a new queue from the current adaptive plan.
   * Uses URL params (wordCount, minutes, targetLevel, mode, hearts) as prefs.
   * If planIdHint is supplied, warns (but does not throw) on planId mismatch.
   *
   * @param {string|null} planIdHint  Optional planId to verify after start.
   * @returns {{ queueId, planId, totalItems, items, cursor }}
   */
  async function loadPlanQueue(planIdHint) {
    // Clear cache at entry so a mid-flight failure never leaves stale items
    _activeQueue = null;
    _queueItems  = [];

    var params = resolveQueueParams();
    var prefs = {};
    if (params.minutes   > 0) prefs.minutes    = params.minutes;
    if (params.wordCount > 0) prefs.wordCount   = params.wordCount;
    if (params.targetLevel)   prefs.targetLevel = params.targetLevel;
    if (params.mode)          prefs.mode        = params.mode;
    if (params.hearts    > 0) prefs.hearts      = params.hearts;

    var startResult = await _api().post('/progress/queue/start', prefs);
    if (!startResult || !startResult.queueId) {
      throw new Error('loadPlanQueue: queue/start returned no queueId');
    }

    if (planIdHint && startResult.planId && String(startResult.planId) !== String(planIdHint)) {
      console.warn('[adaptiveQueue] loadPlanQueue: planId mismatch — expected', planIdHint, ', got', startResult.planId, '(plan may have been regenerated; proceeding with new queue)');
    }

    var currentResp = await _api().get('/progress/queue/current');
    var active = currentResp && currentResp.activeQueue;
    if (!active || !Array.isArray(active.items) || !active.items.length) {
      var emptyErr = new Error('loadPlanQueue: queue started but returned no items');
      emptyErr.code = 'QUEUE_EMPTY';
      throw emptyErr;
    }
    if (String(active.queueId) !== String(startResult.queueId)) {
      var mismatchErr = new Error('loadPlanQueue: QUEUE_MISMATCH — started queueId does not match current active queue');
      mismatchErr.code = 'QUEUE_MISMATCH';
      mismatchErr.expected = startResult.queueId;
      mismatchErr.actual = active.queueId;
      throw mismatchErr;
    }

    _activeQueue = active;
    _queueItems  = active.items.map(function (item) {
      return _normalizeItem(item, active.queueId, active.version);
    }).filter(Boolean);

    return {
      queueId:    active.queueId,
      planId:     active.planId || startResult.planId || null,
      totalItems: _queueItems.length,
      items:      _queueItems.slice(),
      cursor:     active.cursor || { nextIndex: 0, completedCount: 0 },
    };
  }

  // ── loadActiveQueue ──────────────────────────────────────────────────────
  /**
   * Load the currently active queue from the backend.
   * If queueIdHint is supplied, throws QUEUE_MISMATCH when it does not match.
   * Throws NO_ACTIVE_QUEUE when no queue is active.
   *
   * @param {string|null} queueIdHint  Optional queueId to validate.
   * @returns {{ queueId, planId, totalItems, items, cursor }}
   */
  async function loadActiveQueue(queueIdHint) {
    // Clear cache at entry so a mid-flight failure never leaves stale items
    _activeQueue = null;
    _queueItems  = [];

    var resp   = await _api().get('/progress/queue/current');
    var active = resp && resp.activeQueue;

    if (!active || !Array.isArray(active.items) || !active.items.length) {
      _activeQueue = null;
      _queueItems  = [];
      var noQueueErr = new Error('NO_ACTIVE_QUEUE');
      noQueueErr.code = 'NO_ACTIVE_QUEUE';
      throw noQueueErr;
    }

    if (queueIdHint && String(active.queueId) !== String(queueIdHint)) {
      _activeQueue = null;
      _queueItems  = [];
      var mismatchErr = new Error('QUEUE_MISMATCH');
      mismatchErr.code     = 'QUEUE_MISMATCH';
      mismatchErr.expected = queueIdHint;
      mismatchErr.actual   = active.queueId;
      throw mismatchErr;
    }

    _activeQueue = active;
    _queueItems  = active.items.map(function (item) {
      return _normalizeItem(item, active.queueId, active.version);
    }).filter(Boolean);

    return {
      queueId:    active.queueId,
      planId:     active.planId || null,
      totalItems: _queueItems.length,
      items:      _queueItems.slice(),
      cursor:     active.cursor || { nextIndex: 0, completedCount: 0 },
    };
  }

  // ── consumeQueueItem ─────────────────────────────────────────────────────
  /**
   * Return the item at the given index from the cached queue.
   * Returns null when the index is out of bounds or the queue is not loaded.
   * Returns null when queueId is given but doesn't match the cached queue.
   *
   * @param {string}  queueId  Optional — validates against cached queue.
   * @param {number}  index    Zero-based position.
   * @returns {object|null}
   */
  function consumeQueueItem(queueId, index) {
    if (!_activeQueue || !_queueItems.length) return null;
    if (queueId && String(_activeQueue.queueId) !== String(queueId)) return null;
    var i = Math.max(0, Math.floor(Number(index) || 0));
    if (i >= _queueItems.length) return null;
    return _queueItems[i] || null;
  }

  // ── submitAttempt ────────────────────────────────────────────────────────
  /**
   * Submit one queue attempt with an auto-generated idempotency key.
   *
   * @param {string} queueId
   * @param {{ queueItemId, mode, correctness, latencyMs, expectedVersion?, expectedPosition? }} payload
   * @returns {Promise<object>} backend response
   */
  async function submitAttempt(queueId, payload) {
    if (!queueId || !payload || !payload.queueItemId) {
      throw new Error('submitAttempt: queueId and payload.queueItemId are required');
    }
    var idempotencyKey = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
    var body = {
      queueId:          String(queueId),
      queueItemId:      String(payload.queueItemId),
      mode:             String(payload.mode || 'flashcards'),
      correctness:      _normalizeCorrectness(payload.correctness),
      latencyMs:        Math.max(0, Number(payload.latencyMs || 0)),
      idempotencyKey:   idempotencyKey,
      expectedPosition: Number(payload.expectedPosition || 0),
    };
    if (payload.expectedVersion) {
      body.expectedVersion = Number(payload.expectedVersion);
    }
    return _api().postWithRetry('/progress/queue/attempt', body, { retries: 2 });
  }

  // ── onQueueComplete ──────────────────────────────────────────────────────
  /**
   * Call this when an exercise session ends.
   * Saves progress to the backend and abandons the queue if not fully consumed.
   *
   * @param {string|null} queueId  The active queueId (or pass null to use cached).
   * @param {{ sessionType, xpEarned, accuracy, wordsCompleted, durationSeconds, attempts? }} sessionSummary
   * @returns {Promise<{ queueId, allConsumed, progressSaved, queueAbandoned, progressResponse? }>}
   */
  async function onQueueComplete(queueId, sessionSummary) {
    var summary = (sessionSummary && typeof sessionSummary === 'object') ? sessionSummary : {};
    var resolvedQueueId = queueId || (_activeQueue && _activeQueue.queueId) || null;
    var results = { queueId: resolvedQueueId, allConsumed: false, progressSaved: false, queueAbandoned: false };

    // Determine if the queue was fully consumed.
    // If the caller explicitly passes allConsumed (e.g. from page-level tracking),
    // trust it — the in-memory cursor is the initial-load value and is NOT
    // updated after each submitAttempt, so it would always read 0.
    if (typeof summary.allConsumed === 'boolean') {
      results.allConsumed = summary.allConsumed;
    } else if (_activeQueue) {
      var totalItems = Array.isArray(_activeQueue.items) ? _activeQueue.items.length : 0;
      var completed  = Number((_activeQueue.cursor && _activeQueue.cursor.completedCount) || 0);
      results.allConsumed = totalItems > 0 && completed >= totalItems;
    }

    // Save progress
    try {
      var progressPayload = {
        sessionType:    String(summary.sessionType || 'flashcards'),
        xpEarned:       Math.max(0, Number(summary.xpEarned || 0)),
        accuracy:       Math.max(0, Math.min(100, Number(summary.accuracy || 0))),
        wordsCompleted: Math.max(0, Number(summary.wordsCompleted || 0)),
        duration:       Math.max(0, Number(summary.durationSeconds || 0)),
        attempts:       Array.isArray(summary.attempts) ? summary.attempts : [],
      };
      results.progressResponse = await _api().post('/progress', progressPayload);
      results.progressSaved = true;
    } catch (err) {
      console.warn('[adaptiveQueue] onQueueComplete: /progress save failed:', (err && err.message) || err);
      results.progressError = (err && err.message) || String(err);
    }

    // If the queue was not fully consumed, abandon it so it does not block the next session
    if (!results.allConsumed && resolvedQueueId) {
      try {
        await _api().post('/progress/queue/abandon', {});
        results.queueAbandoned = true;
      } catch (abandonErr) {
        // non-fatal; backend will clean up on next queue start
        console.warn('[adaptiveQueue] onQueueComplete: queue abandon failed:', (abandonErr && abandonErr.message) || abandonErr);
      }
    }

    return results;
  }

  // ── Cached accessors ─────────────────────────────────────────────────────
  function getCachedItems() { return _queueItems.slice(); }
  function getCachedQueue() { return _activeQueue; }
  /**
   * Returns { nextIndex, completedCount } from the cached active queue cursor,
   * or { nextIndex: 0, completedCount: 0 } when no queue is loaded.
   * Exercise pages should use this instead of getCachedQueue()?.cursor.
   */
  function getCachedCursor() {
    if (!_activeQueue || !_activeQueue.cursor) return { nextIndex: 0, completedCount: 0 };
    return {
      nextIndex:      Number(_activeQueue.cursor.nextIndex || 0),
      completedCount: Number(_activeQueue.cursor.completedCount || 0),
    };
  }

  // ── Expose on root (window in browser) ───────────────────────────────────
  root.adaptiveQueue = {
    resolveQueueParams: resolveQueueParams,
    loadPlanQueue:      loadPlanQueue,
    loadActiveQueue:    loadActiveQueue,
    consumeQueueItem:   consumeQueueItem,
    submitAttempt:      submitAttempt,
    onQueueComplete:    onQueueComplete,
    getCachedItems:     getCachedItems,
    getCachedQueue:     getCachedQueue,
    getCachedCursor:    getCachedCursor,
  };

})(
  typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this),
  function () {
    // Lazy accessor so tests can set global.api before calling functions.
    /* global api */
    return typeof api !== 'undefined' ? api : null;
  }
);
