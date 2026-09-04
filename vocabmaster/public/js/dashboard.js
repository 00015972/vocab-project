if (!requireAuth()) {
  // Redirect is handled in requireAuth; avoid throwing uncaught errors.
}

let allWords = [];
let currentUser = null;

async function init() {
  initSidebar('dashboard');
  try {
    const me = await api.get('/auth/me');
    currentUser = me.user;
    if ((currentUser.role || 'creator') === 'student') {
      window.location.href = '/student-learn-v3.html';
      return;
    }
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  await loadWords();
  await loadStats();
}

async function loadWords() {
  try {
    const data = await api.get('/words');
    allWords = data.words;
    renderWords();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadStats() {
  try {
    const s = await api.get('/words/stats');
    document.getElementById('statTotal').textContent = s.total;
    document.getElementById('statWeek').textContent = s.thisWeek;
    document.getElementById('statAvgDiff').textContent = s.avgDifficulty || '—';
  } catch {}
}

function renderWords() {
  const q = document.getElementById('searchWords').value.toLowerCase();
  const filtered = allWords.filter(w =>
    w.word.toLowerCase().includes(q) ||
    w.definition.toLowerCase().includes(q) ||
    (w.example||'').toLowerCase().includes(q)
  );
  document.getElementById('wordCount').textContent = allWords.length + ' word' + (allWords.length!==1?'s':'');
  const grid = document.getElementById('wordGrid');
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="icon">${allWords.length?'🔍':'📖'}</div><p>${allWords.length?'No results found.':'No words yet. Add your first word!'}</p></div>`;
    return;
  }
  grid.innerHTML = filtered.map(w => `
    <div class="word-card">
      <div class="word-title">${esc(w.word)}</div>
      ${w.partOfSpeech && w.partOfSpeech!=='other' ? `<span class="pos-badge">${esc(w.partOfSpeech)}</span>` : ''}
      <div class="word-def">${esc(w.definition)}</div>
      ${w.example ? `<div class="word-ex">"${esc(w.example)}"</div>` : ''}
      ${w.notes ? `<div style="margin-top:8px;font-size:0.78rem;color:var(--muted);border-top:1px solid var(--border);padding-top:8px">📝 ${esc(w.notes)}</div>` : ''}
      <div class="word-actions">
        <button class="btn btn-secondary btn-sm" onclick="editWord('${w._id}')">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteWord('${w._id}')">🗑️</button>
      </div>
    </div>
  `).join('');
}

async function saveWord() {
  const word = document.getElementById('inputWord').value.trim();
  const definition = document.getElementById('inputDef').value.trim();
  if (!word || !definition) { showToast('Word and definition are required!', 'error'); return; }

  const payload = {
    word,
    definition,
    partOfSpeech: document.getElementById('inputPos').value,
    example: document.getElementById('inputEx').value.trim(),
    notes: document.getElementById('inputNotes').value.trim(),
    difficulty: parseInt(document.getElementById('inputDiff').value) || 3,
  };

  const editingId = document.getElementById('editingId').value;
  const btn = document.getElementById('saveBtn');
  setLoading(btn, true, 'Saving...');
  try {
    if (editingId) {
      const data = await api.put('/words/' + editingId, payload);
      const i = allWords.findIndex(w => w._id === editingId);
      if (i >= 0) allWords[i] = data.word;
      showToast('Word updated!', 'success');
    } else {
      const data = await api.post('/words', payload);
      allWords.unshift(data.word);
      showToast('Word added!', 'success');
    }
    clearForm();
    renderWords();
    loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

function editWord(id) {
  const w = allWords.find(x => x._id === id);
  if (!w) return;
  document.getElementById('inputWord').value = w.word;
  document.getElementById('inputPos').value = w.partOfSpeech || 'other';
  document.getElementById('inputDef').value = w.definition;
  document.getElementById('inputEx').value = w.example || '';
  document.getElementById('inputNotes').value = w.notes || '';
  document.getElementById('inputDiff').value = w.difficulty || 3;
  document.getElementById('editingId').value = id;
  document.getElementById('formTitle').textContent = '✏️ Edit Word';
  window.scrollTo({top:0, behavior:'smooth'});
}

async function deleteWord(id) {
  if (!confirm('Delete this word?')) return;
  try {
    await api.delete('/words/' + id);
    allWords = allWords.filter(w => w._id !== id);
    renderWords();
    loadStats();
    showToast('Word deleted.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function clearForm() {
  ['inputWord','inputDef','inputEx','inputNotes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('inputPos').value = 'other';
  document.getElementById('inputDiff').value = '3';
  document.getElementById('editingId').value = '';
  document.getElementById('formTitle').textContent = '➕ Add New Word';
}

async function aiAutoFill() {
  const word = document.getElementById('inputWord').value.trim();
  if (!word) { showToast('Enter a word first!', 'error'); return; }
  const btn = document.getElementById('aiBtn');
  setLoading(btn, true, 'AI thinking...');
  try {
    const pos = document.getElementById('inputPos').value;
    const data = await api.post('/ai/generate', { word, partOfSpeech: pos !== 'other' ? pos : undefined });
    if (data.definition) document.getElementById('inputDef').value = data.definition;
    if (data.example) document.getElementById('inputEx').value = data.example;
    if (data.partOfSpeech && pos === 'other') document.getElementById('inputPos').value = data.partOfSpeech;
    showToast('✅ AI filled in the details!', 'success');
  } catch (err) {
    showToast('AI error: ' + err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

if (requireAuth()) {
  init();
}
