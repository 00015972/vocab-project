(function (root) {
  'use strict';

  var STORAGE_KEY = 'taleem_deck_practice_session_v1';
  var DEFAULT_FLOW = ['flashcards', 'quiz', 'matching', 'spelling'];

  function safeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeDifficulty(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(1, Math.min(5, Math.round(numeric))) : 3;
  }

  function shuffleArray(items) {
    var copy = Array.isArray(items) ? items.slice() : [];
    for (var index = copy.length - 1; index > 0; index -= 1) {
      var swapIndex = Math.floor(Math.random() * (index + 1));
      var temp = copy[index];
      copy[index] = copy[swapIndex];
      copy[swapIndex] = temp;
    }
    return copy;
  }

  function normalizeWord(raw) {
    var item = raw && typeof raw === 'object' ? raw : {};
    var word = safeText(item.word || item.term);
    var definition = safeText(item.definition || item.def);
    if (!word || !definition) return null;
    return {
      _id: safeText(item._id || item.wordId || (word + '::' + definition)),
      deckId: safeText(item.deckId),
      word: word,
      definition: definition,
      example: safeText(item.example),
      hint: safeText(item.hint || item.example || item.definition),
      imageUrl: safeText(item.imageUrl),
      difficulty: normalizeDifficulty(item.difficulty),
      partOfSpeech: safeText(item.partOfSpeech),
    };
  }

  function readState() {
    try {
      var raw = root.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return { activeId: '', sessions: {} };
      var parsed = JSON.parse(raw);
      return {
        activeId: safeText(parsed && parsed.activeId),
        sessions: parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      };
    } catch (_err) {
      return { activeId: '', sessions: {} };
    }
  }

  function writeState(state) {
    try {
      root.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_err) {}
  }

  function pruneSessions(state) {
    var entries = Object.keys(state.sessions || {}).map(function (sessionId) {
      return state.sessions[sessionId];
    }).filter(Boolean).sort(function (left, right) {
      return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
    });

    var nextSessions = {};
    entries.slice(0, 8).forEach(function (entry) {
      nextSessions[entry.id] = entry;
    });
    state.sessions = nextSessions;
    if (state.activeId && !state.sessions[state.activeId]) {
      state.activeId = entries.length ? entries[0].id : '';
    }
    return state;
  }

  function createSession(payload) {
    var words = shuffleArray((Array.isArray(payload && payload.words) ? payload.words : []).map(normalizeWord).filter(Boolean));
    if (!words.length) return null;
    var id = safeText(payload && payload.id) || ('deck-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    var flowModes = Array.isArray(payload && payload.flowModes) && payload.flowModes.length
      ? payload.flowModes.map(function (mode) { return safeText(mode).toLowerCase(); }).filter(Boolean)
      : DEFAULT_FLOW.slice();
    var session = {
      id: id,
      deckId: safeText(payload && payload.deckId),
      deckName: safeText(payload && payload.deckName),
      deckTopic: safeText(payload && payload.deckTopic),
      flowModes: flowModes,
      createdAt: new Date().toISOString(),
      words: words,
    };
    var state = readState();
    state.sessions[id] = session;
    state.activeId = id;
    writeState(pruneSessions(state));
    return session;
  }

  function getSession(sessionId) {
    var requestedId = safeText(sessionId);
    var state = readState();
    var resolvedId = requestedId || state.activeId;
    if (!resolvedId) return null;
    return state.sessions[resolvedId] || null;
  }

  function getSessionFromUrl() {
    var params = new URLSearchParams((root.location && root.location.search) || '');
    return getSession(params.get('deckSessionId'));
  }

  function resolveModePath(mode) {
    return {
      flashcards: 'flashcards-ultra.html',
      quiz: 'quiz-ultra.html',
      matching: 'matching-ultra.html',
      spelling: 'spelling-ultra.html',
    }[safeText(mode).toLowerCase()] || 'flashcards-ultra.html';
  }

  function buildExerciseUrl(mode, session, extraParams) {
    if (!session || !session.id) return resolveModePath(mode);
    var params = new URLSearchParams();
    params.set('deckSessionId', session.id);
    if (session.deckId) params.set('deckId', session.deckId);
    if (session.deckName) params.set('deckName', session.deckName);
    if (session.deckTopic) params.set('deckTopic', session.deckTopic);
    params.set('wordCount', String(Array.isArray(session.words) ? session.words.length : 0));
    params.set('flow', (Array.isArray(session.flowModes) && session.flowModes.length ? session.flowModes : DEFAULT_FLOW).join(','));
    params.set('mode', safeText(mode).toLowerCase() || 'flashcards');
    params.set('autoNext', 'true');
    if (extraParams && typeof extraParams === 'object') {
      Object.keys(extraParams).forEach(function (key) {
        if (extraParams[key] !== undefined && extraParams[key] !== null) {
          params.set(key, String(extraParams[key]));
        }
      });
    }
    return resolveModePath(mode) + '?' + params.toString();
  }

  root.deckPracticeSession = {
    createSession: createSession,
    getSession: getSession,
    getSessionFromUrl: getSessionFromUrl,
    buildExerciseUrl: buildExerciseUrl,
    resolveModePath: resolveModePath,
  };
})(window);