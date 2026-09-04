/* ── Auth State ────────────────────────────────────────────────── */
const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const useLocalApiFallback =
  window.location.protocol === 'file:' ||
  (isLocalHost && window.location.port && window.location.port !== '3000');
const API_BASE = useLocalApiFallback ? 'http://localhost:3000/api' : '/api';

let csrfTokenCache = null;
const AUTH_SESSION_MARKER = 'http-only-cookie';

// Remove legacy JWTs that older releases stored in Web Storage.
if (localStorage.getItem('token') && localStorage.getItem('token') !== AUTH_SESSION_MARKER) {
  localStorage.removeItem('token');
}

async function getCSRFToken() {
  if (csrfTokenCache) return csrfTokenCache;
  try {
    const res = await fetch(API_BASE + '/csrf-token', { credentials: 'include' });
    const data = await res.json();
    csrfTokenCache = data.csrfToken;
    return csrfTokenCache;
  } catch (err) {
    console.error('Failed to fetch CSRF token:', err);
    return null;
  }
}

// Compatibility helper for older pages. This is only a non-secret UI marker;
// the real session credential is held in an HttpOnly cookie.
function getToken()  { return localStorage.getItem('token') === AUTH_SESSION_MARKER ? AUTH_SESSION_MARKER : null; }
function getUser()   { 
  try {
    const userJson = localStorage.getItem('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch (err) {
    console.error('localStorage corruption detected:', err);
    clearAuth();
    return null;
  }
}
function setAuth(_token, user) {
  localStorage.setItem('token', AUTH_SESSION_MARKER);
  localStorage.setItem('user', JSON.stringify(user));
}
function clearAuth() {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(API_BASE + '/auth/logout');
  }
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}
function requireAuth() {
  if (!getToken()) { window.location.href = '/login-ultra.html'; return false; }
  return true;
}
function redirectIfAuth() {
  if (getToken()) {
    const user = getUser();
    if (user && user.role === 'admin') {
      window.location.href = '/admin-dashboard.html';
    } else if (user && user.role === 'creator') {
      window.location.href = '/creator-dashboard-new.html';
    } else {
      window.location.href = '/student-learn-v3.html';
    }
  }
}

/* ── API Helper ────────────────────────────────────────────────── */
async function apiRequest(method, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  // Add CSRF token for state-changing requests
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = await getCSRFToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await res.json()
      : { message: await res.text() };
    if (res.status === 401) { clearAuth(); window.location.href = '/login-ultra.html'; return; }
    if (!res.ok) {
      const err = new Error(data.message || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    if (err.message === 'Failed to fetch') throw new Error('Cannot connect to server. Is it running?');
    throw err;
  }
}

/**
 * POST with retry/backoff for queue attempts.
 * On 409 it will optionally refetch `/progress/queue/current` and retry up to `options.retries`.
 */
async function postWithRetry(path, body, options = {}) {
  const retries = Number(options.retries || 2);
  const backoffs = options.backoffs || [200, 500, 1000];
  let attempt = 0;
  while (true) {
    try {
      return await apiRequest('POST', path, body, options);
    } catch (err) {
      attempt += 1;
      const status = err && err.status ? Number(err.status) : null;
      if (status === 409 && attempt <= retries) {
        // Try to refresh queue state if this is a queue attempt
        try {
          await apiRequest('GET', '/progress/queue/current');
        } catch (refreshErr) {
          // ignore
        }
        const wait = backoffs[Math.min(attempt - 1, backoffs.length - 1)] || 300;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

const api = {
  get:    (path, options)              => apiRequest('GET',    path, undefined, options),
  post:   (path, body, options)        => apiRequest('POST',   path, body, options),
  postWithRetry: (path, body, options) => postWithRetry(path, body, options),
  put:    (path, body, options)        => apiRequest('PUT',    path, body, options),
  patch:  (path, body, options)        => apiRequest('PATCH',  path, body, options),
  delete: (path, options)              => apiRequest('DELETE', path, undefined, options),
};

/* ── Achievement Unlocks ──────────────────────────────────────── */
function achievementCacheKey(user) {
  const userId = String(user?._id || user?.id || user?.email || 'anon');
  return `achievements_unlocked_cache_${userId}`;
}

function getCachedUnlockedAchievements(user) {
  try {
    const raw = localStorage.getItem(achievementCacheKey(user));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setCachedUnlockedAchievements(user, ids) {
  try {
    localStorage.setItem(achievementCacheKey(user), JSON.stringify(Array.isArray(ids) ? ids : []));
  } catch {
    // Ignore storage quota failures.
  }
}

async function detectNewAchievementUnlocks() {
  const user = getUser();
  const token = getToken();
  if (!user || !token) return [];

  const payload = await api.get('/progress/achievements');
  const unlocked = Array.isArray(payload?.unlocked) ? payload.unlocked : [];
  const unlockedIds = unlocked.map((item) => String(item.id || ''));
  const previousIds = getCachedUnlockedAchievements(user);
  const previousSet = new Set(previousIds);
  const newUnlocks = unlocked.filter((item) => !previousSet.has(String(item.id || '')));

  setCachedUnlockedAchievements(user, unlockedIds);
  return newUnlocks;
}

if (typeof window !== 'undefined') {
  window.detectNewAchievementUnlocks = detectNewAchievementUnlocks;
}

/* ── Streak Milestones ─────────────────────────────────────────── */
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

function streakCacheKey(user) {
  const userId = String(user?._id || user?.id || user?.email || 'anon');
  return `streak_milestone_cache_${userId}`;
}

function getCachedStreakMilestone(user) {
  try {
    const raw = localStorage.getItem(streakCacheKey(user));
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function setCachedStreakMilestone(user, value) {
  try {
    localStorage.setItem(streakCacheKey(user), String(value));
  } catch {
    // Ignore storage quota failures.
  }
}

async function detectStreakMilestone() {
  const user = getUser();
  const token = getToken();
  if (!user || !token) return null;

  try {
    const stats = await api.get('/progress/stats');
    const current = Number(stats?.streak || 0);
    const previous = getCachedStreakMilestone(user);

    setCachedStreakMilestone(user, current);

    // Find the highest milestone crossed since last check
    const hit = STREAK_MILESTONES.slice().reverse().find(
      (m) => current >= m && previous < m
    );
    if (!hit) return null;

    const labels = {
      3:   { emoji: '🔥', label: '3-Day Streak!',   msg: 'You\'re on a roll — 3 days in a row!' },
      7:   { emoji: '⚡', label: 'Week Warrior!',    msg: '7-day streak achieved. Keep it up!' },
      14:  { emoji: '🌟', label: '2-Week Streak!',   msg: 'Two solid weeks of learning!' },
      30:  { emoji: '🏆', label: 'Month Master!',    msg: '30 days straight — incredible!' },
      60:  { emoji: '👑', label: '60-Day Streak!',   msg: 'Two months of daily dedication!' },
      100: { emoji: '🎓', label: 'Century Scholar!', msg: '100-day streak — a true milestone!' },
    };
    return { days: hit, ...(labels[hit] || { emoji: '🔥', label: `${hit}-Day Streak!`, msg: `${hit} days in a row!` }) };
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.detectStreakMilestone = detectStreakMilestone;
}

/* ── Hearts System ─────────────────────────────────────────────── */
const HEARTS_MAX = 5;
const HEARTS_RECOVERY_MS = 4 * 60 * 60 * 1000; // 4 hours

function heartsCacheKey(user) {
  const userId = String(user?._id || user?.id || user?.email || 'anon');
  return `hearts_state_${userId}`;
}

function getHeartsState() {
  const user = getUser();
  if (!user) return { count: HEARTS_MAX, lastResetDate: null, lastDrainAt: null };
  try {
    const raw = localStorage.getItem(heartsCacheKey(user));
    return raw ? JSON.parse(raw) : { count: HEARTS_MAX, lastResetDate: null, lastDrainAt: null };
  } catch {
    return { count: HEARTS_MAX, lastResetDate: null, lastDrainAt: null };
  }
}

function saveHeartsState(state) {
  const user = getUser();
  if (!user) return;
  try {
    localStorage.setItem(heartsCacheKey(user), JSON.stringify(state));
  } catch { /* ignore */ }
}

function todayUtcKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getHearts() {
  let state = getHeartsState();
  // Daily reset — new UTC day restores all hearts
  const today = todayUtcKey();
  if (state.lastResetDate !== today) {
    state = { count: HEARTS_MAX, lastResetDate: today, lastDrainAt: state.lastDrainAt };
    saveHeartsState(state);
  }
  // Passive recovery — 1 heart per 4 hours since last drain, up to max
  if (state.count < HEARTS_MAX && state.lastDrainAt) {
    const elapsed = Date.now() - Number(state.lastDrainAt);
    const recovered = Math.floor(elapsed / HEARTS_RECOVERY_MS);
    if (recovered > 0) {
      state.count = Math.min(HEARTS_MAX, state.count + recovered);
      // Advance lastDrainAt by the recovered slots so we never double-apply
      state.lastDrainAt = Number(state.lastDrainAt) + (recovered * HEARTS_RECOVERY_MS);
      if (state.count >= HEARTS_MAX) state.lastDrainAt = null; // full → no more recovery needed
      saveHeartsState(state);
    }
  }
  return state.count;
}

function drainHeart() {
  // Call getHearts() first so daily-reset and passive-recovery are both applied
  // before we drain, then read the saved (already-updated) state.
  getHearts();
  let state = getHeartsState();
  if (state.count > 0) state.count -= 1;
  state.lastDrainAt = Date.now();
  saveHeartsState(state);
  refreshHeartsUI();
  return state.count;
}

function refreshHeartsUI() {
  const count = getHearts();
  const el = document.getElementById('hearts');
  if (!el) return;
  el.innerHTML = `<span class="chance-icon" aria-hidden="true"><dotlottie-wc src="https://lottie.host/39bd707b-67ef-41a4-9d1b-a991130d2bab/bNsbDC5YV9.lottie" autoplay loop style="width:100%;height:100%"></dotlottie-wc></span><span class="stat-text">${count}</span>`;
  el.title = `${count} / ${HEARTS_MAX} chances`;
}

if (typeof window !== 'undefined') {
  window.getHearts = getHearts;
  window.drainHeart = drainHeart;
  window.refreshHeartsUI = refreshHeartsUI;
  window.HEARTS_MAX = HEARTS_MAX;
}

/* ── XP / Daily Bonus ──────────────────────────────────────────── */
const MODE_XP_MULTIPLIERS = {
  flashcards: 1.0,
  quiz:       1.2,
  matching:   1.1,
  spelling:   1.3,
  listening:  1.1,
  speaking:   1.2,
};
const DAILY_BONUS_XP = 50;

function dailyBonusCacheKey(user) {
  const userId = String(user?._id || user?.id || user?.email || 'anon');
  return `daily_bonus_date_${userId}`;
}

/**
 * Returns DAILY_BONUS_XP (50) the first time it's called on a given UTC day,
 * 0 on subsequent calls the same day. Safe to call from every saveSessionProgress.
 */
function checkAndClaimDailyBonus() {
  const user = getUser();
  if (!user) return 0;
  const key = dailyBonusCacheKey(user);
  const today = todayUtcKey();
  try {
    if (localStorage.getItem(key) === today) return 0;
    localStorage.setItem(key, today);
    return DAILY_BONUS_XP;
  } catch {
    return 0;
  }
}

/**
 * Apply a mode multiplier (rounded) to raw XP.
 * @param {number} rawXP
 * @param {string} mode  e.g. 'quiz', 'spelling'
 * @returns {number}
 */
function applyModeMultiplier(rawXP, mode) {
  const m = MODE_XP_MULTIPLIERS[String(mode).toLowerCase()] || 1.0;
  return Math.round(rawXP * m);
}

if (typeof window !== 'undefined') {
  window.checkAndClaimDailyBonus = checkAndClaimDailyBonus;
  window.applyModeMultiplier = applyModeMultiplier;
  window.MODE_XP_MULTIPLIERS = MODE_XP_MULTIPLIERS;
  window.DAILY_BONUS_XP = DAILY_BONUS_XP;
}

function extractGamificationState(result) {
  const gamification = result && result.gamification ? result.gamification : null;
  const level = result && result.level
    ? result.level
    : (gamification && gamification.level ? gamification.level : null);
  return { level, gamification };
}

function showGamificationMoments(result, options = {}) {
  const state = extractGamificationState(result);
  const level = state.level;
  const gamification = state.gamification;

  const modeLabel = String(options.modeLabel || 'Session').trim();
  const celebrate = typeof options.celebrate === 'function' ? options.celebrate : null;

  if (level) {
    const levelValue = Number(level.current || level.level || 1);
    const xpToNextLevel = Number(level.xpToNextLevel || 0);
    if (levelValue > 0) {
      const text = xpToNextLevel > 0
        ? `${modeLabel}: Level ${levelValue} • ${xpToNextLevel} XP to next`
        : `${modeLabel}: Level ${levelValue} • Max level reached`;
      showToast(text, 'info', 3400);
    }
  }

  if (gamification && gamification.level && gamification.level.leveledUp) {
    showToast(`Level up! You reached Level ${gamification.level.current}.`, 'success', 4200);
    if (celebrate) celebrate();
  }

  if (gamification && gamification.streak && gamification.streak.milestone && gamification.streak.milestone.days) {
    showToast(`Streak milestone: ${gamification.streak.milestone.days} days in a row!`, 'success', 4200);
    if (celebrate) celebrate();
  }

  const newUnlocks = gamification && gamification.achievements && Array.isArray(gamification.achievements.newlyUnlocked)
    ? gamification.achievements.newlyUnlocked
    : [];

  newUnlocks.forEach((item, idx) => {
    setTimeout(() => {
      showToast(`Achievement unlocked: ${item.title}`, 'success', 4500);
      if (celebrate) celebrate();
    }, idx * 800);
  });

  return {
    level,
    gamification,
    newUnlocks,
  };
}

let activeTTSAudio = null;

async function playTTSAudio(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) throw new Error('No text to pronounce.');

  if (activeTTSAudio) {
    activeTTSAudio.pause();
    activeTTSAudio = null;
  }

  const endpoint = (typeof API_BASE === 'string' ? API_BASE : '/api') + '/tts';
  const provider = String(options.provider || 'cartesia').trim().toLowerCase();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, provider }),
    });

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || 'TTS request failed');
    }

    const blob = await res.blob();
    if (!blob || !blob.size) throw new Error('Empty audio response');

    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    activeTTSAudio = audio;

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(audioUrl);
      if (activeTTSAudio === audio) activeTTSAudio = null;
    }, { once: true });

    audio.addEventListener('error', () => {
      URL.revokeObjectURL(audioUrl);
      if (activeTTSAudio === audio) activeTTSAudio = null;
    }, { once: true });

    await audio.play();
    return { source: 'api', audio };
  } catch (err) {
    if (options.allowBrowserFallback === false) throw err;

    if (typeof window !== 'undefined' && window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined') {
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.rate = Number(options.rate || 0.9);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return { source: 'browser', utterance };
    }

    throw err;
  }
}

if (typeof window !== 'undefined') {
  window.showGamificationMoments = showGamificationMoments;
  window.playTTSAudio = playTTSAudio;
}

/* ── Toast ─────────────────────────────────────────────────────── */
function showToast(message, type = 'info', duration = 3000) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.className = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, duration);
}

/* ── Loading State ─────────────────────────────────────────────── */
function setLoading(btn, loading, loadingText = 'Loading...') {
  if (!btn) return;
  if (loading) {
    btn._originalText = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
    btn.disabled = true;
  } else {
    btn.innerHTML = btn._originalText || 'Submit';
    btn.disabled = false;
  }
}

/* ── Sidebar ───────────────────────────────────────────────────── */
function initSidebar(activeItem) {
  const user = getUser();
  if (user) {
    const avatar = document.getElementById('userAvatar');
    const userName = document.getElementById('sidebarUserName');
    const userEmail = document.getElementById('sidebarUserEmail');
    if (avatar) avatar.textContent = user.name.charAt(0).toUpperCase();
    if (userName) userName.textContent = user.name;
    if (userEmail) userEmail.textContent = user.email;
  }

  if (user && (user.role || 'creator') === 'student') {
    document.querySelectorAll('.nav-item[data-page="dashboard"]').forEach(el => {
      if (el.tagName === 'A') {
        el.setAttribute('href', '/student-learn-v3.html');
      }
      const icon = el.querySelector('.nav-icon');
      el.innerHTML = '';
      if (icon) {
        el.appendChild(icon);
      } else {
        const fallbackIcon = document.createElement('span');
        fallbackIcon.className = 'nav-icon';
        fallbackIcon.textContent = '📚';
        el.appendChild(fallbackIcon);
      }
      el.appendChild(document.createTextNode(' Assigned Words'));
    });
  }

  // Set active item
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.remove('active');
    if (el.dataset.page === activeItem) el.classList.add('active');
  });

  // Mobile toggle
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target) && e.target !== toggle) {
        sidebar.classList.remove('open');
      }
    });
  }
}

function logout() {
  clearAuth();
  window.location.replace('/login.html');
}

if (typeof window !== 'undefined') {
  window.logout = logout;
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-logout]');
    if (!trigger) return;
    event.preventDefault();
    logout();
  });
}

/* ── Escape HTML ───────────────────────────────────────────────── */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
