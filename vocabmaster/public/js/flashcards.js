if (!requireAuth()) {
  // Redirect is handled in requireAuth; avoid throwing uncaught errors.
}

let words = [], deck = [], index = 0, flipped = false;
let status = {}; // wordId -> 'known' | 'learning'

async function init() {
  initSidebar('flashcards');
  try {
    const data = await api.get('/words');
    words = data.words;
    initDeck();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initDeck() {
  const onlyUnknown = document.getElementById('fcOnlyUnknown').checked;
  deck = onlyUnknown ? words.filter(w => status[w._id] !== 'known') : [...words];
  index = 0; flipped = false;
  document.getElementById('fcScene').classList.remove('flipped');
  renderCard();
  updateStats();
}

function renderCard() {
  if (!deck.length) {
    document.getElementById('fcWord').textContent = 'No words!';
    document.getElementById('fcPos').textContent = '';
    document.getElementById('fcDef').textContent = 'Add some words on the Dashboard first.';
    document.getElementById('fcEx').textContent = '';
    document.getElementById('fcProgress').textContent = '0 / 0';
    document.getElementById('fcPrev').disabled = true;
    document.getElementById('fcNext').disabled = true;
    return;
  }
  const w = deck[index];
  document.getElementById('fcWord').textContent = w.word;
  document.getElementById('fcPos').textContent = w.partOfSpeech && w.partOfSpeech !== 'other' ? `(${w.partOfSpeech})` : '';
  document.getElementById('fcDef').textContent = w.definition;
  document.getElementById('fcEx').textContent = w.example ? `"${w.example}"` : '';
  document.getElementById('fcProgress').textContent = `${index + 1} / ${deck.length}`;
  document.getElementById('fcPrev').disabled = index === 0;
  document.getElementById('fcNext').disabled = index === deck.length - 1;
}

function flipCard() {
  flipped = !flipped;
  document.getElementById('fcScene').classList.toggle('flipped', flipped);
}

function navigate(dir) {
  index = Math.max(0, Math.min(deck.length - 1, index + dir));
  flipped = false;
  document.getElementById('fcScene').classList.remove('flipped');
  renderCard();
}

function mark(s) {
  if (!deck.length) return;
  const w = deck[index];
  status[w._id] = s;
  // Record review in backend (fire and forget)
  api.post('/words/' + w._id + '/reviewed', { correct: s === 'known' }).catch(() => {});
  updateStats();
  if (index < deck.length - 1) navigate(1);
  else showToast("You've reviewed all cards!", 'info');
}

function shuffleDeck() {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  index = 0; flipped = false;
  document.getElementById('fcScene').classList.remove('flipped');
  renderCard();
  showToast('Deck shuffled!', 'info');
}

function resetProgress() {
  status = {};
  initDeck();
  showToast('Progress reset.', 'info');
}

function updateStats() {
  const known = Object.values(status).filter(s => s === 'known').length;
  const learning = Object.values(status).filter(s => s === 'learning').length;
  document.getElementById('stKnown').textContent = known;
  document.getElementById('stLearning').textContent = learning;
  document.getElementById('stUnseen').textContent = Math.max(0, words.length - known - learning);
}

if (requireAuth()) {
  init();
}
