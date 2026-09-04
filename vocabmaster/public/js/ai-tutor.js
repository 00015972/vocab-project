if (!requireAuth()) {
  // Redirect is handled in requireAuth; avoid throwing uncaught errors.
}

let words = [];
let chatHistory = [];

async function init() {
  initSidebar('ai-tutor');
  try {
    const data = await api.get('/words');
    words = data.words;
    renderWordChips();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderWordChips() {
  const el = document.getElementById('wordChips');
  if (!words.length) { el.textContent = 'No words yet. Add some on the Dashboard!'; return; }
  el.innerHTML = words.slice(0, 25).map(w =>
    `<span class="word-chip-item" onclick="askAbout('${esc(w.word)}')">${esc(w.word)}</span>`
  ).join(' · ') + (words.length > 25 ? ` · <span style="color:var(--muted)">+${words.length-25} more</span>` : '');
}

function askAbout(word) {
  document.getElementById('chatInput').value = `Explain the word "${word}" in depth, including its origin, meaning, and a memory trick.`;
  sendMsg();
}

function appendMsg(role, html) {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = `<div class="chat-sender">${role === 'ai' ? 'VocabMaster AI' : 'You'}</div><div class="chat-bubble">${html}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function appendTyping() {
  const box = document.getElementById('chatBox');
  const div = document.createElement('div');
  div.className = 'chat-msg ai';
  div.id = 'typingMsg';
  div.innerHTML = `<div class="chat-sender">VocabMaster AI</div><div class="chat-bubble"><span class="spinner" style="color:var(--accent2)"></span></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function removeTyping() {
  const el = document.getElementById('typingMsg');
  if (el) el.remove();
}

async function sendMsg() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  appendMsg('user', esc(msg));
  chatHistory.push({ role: 'user', content: msg });
  appendTyping();
  try {
    const data = await api.post('/ai/chat', {
      messages: chatHistory,
      wordList: words.map(w => w.word),
    });
    removeTyping();
    const reply = data.reply;
    appendMsg('ai', esc(reply).replace(/\n/g, '<br>'));
    chatHistory.push({ role: 'assistant', content: reply });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-18);
  } catch (err) {
    removeTyping();
    appendMsg('ai', `⚠️ Error: ${esc(err.message)}`);
  }
}

function quickAction(type) {
  const wl = words.map(w => w.word).join(', ') || 'no words saved yet';
  const prompts = {
    explain:   'Explain a word in depth for me. Ask which word I want explained.',
    etymology: 'Tell me about the origin and etymology of a word I choose. Ask me which word.',
    synonyms:  'Give me synonyms and antonyms for a word. Ask me which one.',
    sentences: `Create 3 diverse example sentences for a word from my list: ${wl}. Ask me which word.`,
    memory:    'Give me a mnemonic (memory trick) for a word I pick. Ask which word.',
    quiz:      `Quiz me on my saved words: ${wl}. Ask me one at a time with 4 multiple choice options.`,
  };
  document.getElementById('chatInput').value = prompts[type] || '';
  sendMsg();
}

if (requireAuth()) {
  init();
}
