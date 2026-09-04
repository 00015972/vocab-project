const http = require('http');

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const email = `smoke${Date.now()}@example.com`;
  const register = await request('POST', '/api/auth/register', { name: 'Smoke Creator', email, password: 'password123', role: 'creator' });
  if (register.status !== 201) throw new Error(`register failed: ${register.status} ${register.text}`);
  const registerBody = JSON.parse(register.text || '{}');

  const login = await request('POST', '/api/auth/login', {
    email,
    password: 'password123',
    role: 'creator',
    creatorPortalCode: registerBody.creatorCode || '',
  });
  let auth = null;
  if (login.status === 200) {
    auth = JSON.parse(login.text || '{}');
  } else {
    const loginBody = JSON.parse(login.text || '{}');
    const requiresVerification = login.status === 403
      && /verify your email/i.test(String(loginBody.message || ''));
    if (!requiresVerification) {
      throw new Error(`login failed: ${login.status} ${login.text}`);
    }
    if (!registerBody || !registerBody.token) {
      throw new Error(`login blocked by verification and no registration token available: ${login.status} ${login.text}`);
    }
    auth = { token: registerBody.token };
  }

  const seedWords = [
    { word: `smoke_word_${Date.now()}_1`, definition: 'smoke definition one', difficulty: 2, domain: 'general', targetScoreRange: '500-600', learningStatus: 'locked' },
    { word: `smoke_word_${Date.now()}_2`, definition: 'smoke definition two', difficulty: 3, domain: 'general', targetScoreRange: '500-600', learningStatus: 'in_progress' },
    { word: `smoke_word_${Date.now()}_3`, definition: 'smoke definition three', difficulty: 4, domain: 'general', targetScoreRange: '600-700', learningStatus: 'in_progress' },
  ];

  for (const entry of seedWords) {
    const createWord = await request('POST', '/api/words', entry, { Authorization: `Bearer ${auth.token}` });
    if (createWord.status !== 201) throw new Error(`seed word failed: ${createWord.status} ${createWord.text}`);
  }

  const plan = await request('GET', '/api/progress/study-plan?minutes=20&wordCount=8', null, { Authorization: `Bearer ${auth.token}` });
  if (plan.status !== 200) throw new Error(`study-plan failed: ${plan.status} ${plan.text}`);

  const queueStart = await request('POST', '/api/progress/queue/start', { minutes: 20, wordCount: 8, mode: 'flashcards' }, { Authorization: `Bearer ${auth.token}` });
  if (queueStart.status !== 200) throw new Error(`queue-start failed: ${queueStart.status} ${queueStart.text}`);

  const current = await request('GET', '/api/progress/queue/current', null, { Authorization: `Bearer ${auth.token}` });
  if (current.status !== 200) throw new Error(`current queue failed: ${current.status} ${current.text}`);
  const activeQueue = JSON.parse(current.text).activeQueue;
  if (!activeQueue || !Array.isArray(activeQueue.items) || !activeQueue.items.length) {
    throw new Error('current queue has no items to attempt');
  }
  const first = activeQueue.items[0];

  const correctAttempt = await request('POST', '/api/progress/queue/attempt', {
    queueId: activeQueue.queueId,
    queueItemId: first.queueItemId,
    mode: 'flashcards',
    correctness: true,
    latencyMs: 1200,
    idempotencyKey: `correct-${Date.now()}`,
  }, { Authorization: `Bearer ${auth.token}` });
  if (correctAttempt.status !== 200) throw new Error(`correct attempt failed: ${correctAttempt.status} ${correctAttempt.text}`);

  const afterFirst = await request('GET', '/api/progress/queue/current', null, { Authorization: `Bearer ${auth.token}` });
  if (afterFirst.status !== 200) throw new Error(`current queue after first attempt failed: ${afterFirst.status} ${afterFirst.text}`);
  const afterFirstQueue = JSON.parse(afterFirst.text).activeQueue;
  const nextIndex = Number(afterFirstQueue?.cursor?.nextIndex || 0);
  const second = (Array.isArray(afterFirstQueue?.items) ? afterFirstQueue.items[nextIndex] : null) || activeQueue.items[1] || null;

  if (second) {
    const wrongAttempt = await request('POST', '/api/progress/queue/attempt', {
      queueId: activeQueue.queueId,
      queueItemId: second.queueItemId,
      mode: 'flashcards',
      correctness: false,
      latencyMs: 5000,
      idempotencyKey: `wrong-${Date.now()}`,
    }, { Authorization: `Bearer ${auth.token}` });
    if (wrongAttempt.status !== 200) throw new Error(`wrong attempt failed: ${wrongAttempt.status} ${wrongAttempt.text}`);
  }

  console.log('smoke test passed');
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
