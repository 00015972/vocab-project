if (!requireAuth()) {
  // Redirect is handled in requireAuth; avoid throwing uncaught errors.
}

let words = [], questions = [], qIndex = 0, correct = 0, wrong = 0, answered = false;

async function init() {
  initSidebar('quiz');
  try {
    const data = await api.get('/words');
    words = data.words;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showSetup() {
  document.getElementById('setupScreen').classList.remove('hidden');
  document.getElementById('quizScreen').classList.add('hidden');
  document.getElementById('resultsScreen').classList.add('hidden');
}

function startQuiz() {
  if (words.length < 4) { showToast('Add at least 4 words to start a quiz!', 'error'); return; }
  const count = Math.min(parseInt(document.getElementById('qCount').value), words.length);
  const typeMode = document.getElementById('qType').value;
  const dirMode  = document.getElementById('qDir').value;
  const shuffled = [...words].sort(() => Math.random() - 0.5).slice(0, count);
  questions = shuffled.map(w => buildQuestion(w, typeMode, dirMode));
  qIndex = 0; correct = 0; wrong = 0; answered = false;
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('quizScreen').classList.remove('hidden');
  document.getElementById('resultsScreen').classList.add('hidden');
  renderQuestion();
}

function buildQuestion(word, typeMode, dirMode) {
  const qType = typeMode === 'mixed' ? (Math.random() > 0.5 ? 'mc' : 'typed') : typeMode;
  const dir   = dirMode  === 'mixed' ? (Math.random() > 0.5 ? 'def2word' : 'word2def') : dirMode;
  const others = words.filter(w => w._id !== word._id).sort(() => Math.random() - 0.5).slice(0, 3);
  if (dir === 'def2word') {
    return { qType, dir, question: word.definition, answer: word.word, word,
      options: qType === 'mc' ? shuffle([word.word, ...others.map(o => o.word)]) : [] };
  } else {
    return { qType, dir, question: word.word, answer: word.definition, word,
      options: qType === 'mc' ? shuffle([word.definition, ...others.map(o => o.definition)]) : [] };
  }
}

function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }

function renderQuestion() {
  const q = questions[qIndex];
  const total = questions.length;
  document.getElementById('qNum').textContent = `Question ${qIndex + 1} of ${total}`;
  document.getElementById('qProgress').style.width = ((qIndex / total) * 100) + '%';
  document.getElementById('qTypeLabel').textContent =
    (q.qType === 'mc' ? 'Multiple Choice' : 'Type Your Answer') + ' · ' +
    (q.dir === 'def2word' ? 'Definition → Word' : 'Word → Definition');
  document.getElementById('qText').innerHTML = q.dir === 'def2word'
    ? `What word matches this definition?<br><br>"${esc(q.question)}"`
    : `Choose or type the definition for: <span class="word-chip">${esc(q.question)}</span>`;
  answered = false;
  const area = document.getElementById('qAnswerArea');
  const actions = document.getElementById('qActions');
  if (q.qType === 'mc') {
    area.innerHTML = `<div class="mc-options">${q.options.map((opt, i) =>
      `<button class="mc-opt" id="opt${i}" onclick="checkMC(${i})">${esc(opt)}</button>`
    ).join('')}</div>`;
    actions.innerHTML = '';
  } else {
    area.innerHTML = `<div class="typed-area">
      <input type="text" id="typedInput" placeholder="Type your answer..." onkeydown="if(event.key==='Enter'&&!answered)checkTyped()" autofocus />
      <div class="answer-fb" id="typedFb"></div>
    </div>`;
    actions.innerHTML = `<button class="btn btn-primary" onclick="checkTyped()">Check →</button>`;
  }
}

function checkMC(i) {
  if (answered) return;
  answered = true;
  const q = questions[qIndex];
  const isCorrect = q.options[i] === q.answer;
  q.options.forEach((opt, j) => {
    const btn = document.getElementById('opt' + j);
    btn.classList.add('disabled');
    if (opt === q.answer) btn.classList.add('correct');
    else if (j === i && !isCorrect) btn.classList.add('wrong');
  });
  if (isCorrect) correct++; else wrong++;
  document.getElementById('qActions').innerHTML = `<button class="btn btn-primary" onclick="nextQ()">Next →</button>`;
}

function checkTyped() {
  if (answered) { nextQ(); return; }
  const input = document.getElementById('typedInput');
  const val = input.value.trim().toLowerCase();
  if (!val) return;
  answered = true;
  const q = questions[qIndex];
  const correctLow = q.answer.toLowerCase();
  const isCorrect = val === correctLow || correctLow.includes(val) || (val.length > 4 && val.split(' ').some(t => correctLow.includes(t)));
  input.disabled = true;
  const fb = document.getElementById('typedFb');
  if (isCorrect) { correct++; fb.className = 'answer-fb correct'; fb.textContent = '✅ Correct!'; }
  else           { wrong++;   fb.className = 'answer-fb wrong';   fb.textContent = `❌ Answer: ${q.answer}`; }
  document.getElementById('qActions').innerHTML = `<button class="btn btn-primary" onclick="nextQ()">Next →</button>`;
}

function nextQ() {
  qIndex++;
  if (qIndex >= questions.length) { showResults(); return; }
  renderQuestion();
}

function showResults() {
  document.getElementById('quizScreen').classList.add('hidden');
  document.getElementById('resultsScreen').classList.remove('hidden');
  const total = questions.length;
  const pct = Math.round((correct / total) * 100);
  document.getElementById('rScore').textContent = pct + '%';
  document.getElementById('rCorrect').textContent = correct;
  document.getElementById('rWrong').textContent = wrong;
  document.getElementById('rTotal').textContent = total;
  const grades = [[90,'🏆 Excellent!'],[75,'🎉 Great job!'],[60,'👍 Good effort!'],[0,'📖 Keep studying!']];
  document.getElementById('rGrade').textContent = grades.find(([min]) => pct >= min)[1];
  document.getElementById('qProgress').style.width = '100%';
}

if (requireAuth()) {
  init();
}
