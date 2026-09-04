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
  const register = await request('POST', '/api/auth/register', { name: 'Smoke User', email, password: 'password123', role: 'student' });
  if (register.status !== 201) throw new Error(`register failed: ${register.status} ${register.text}`);

  const login = await request('POST', '/api/auth/login', { email, password: 'password123' });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  const auth = JSON.parse(login.text);

  const plan = await request('GET', '/api/progress/study-plan?minutes=20&wordCount=8', null, { Authorization: `Bearer ${auth.token}` });
  if (plan.status !== 200) throw new Error(`study-plan failed: ${plan.status} ${plan.text}`);

  const queueStart = await request('POST', '/api/progress/queue/start', { minutes: 20, wordCount: 8, mode: 'flashcards' }, { Authorization: `Bearer ${auth.token}` });
  if (queueStart.status !== 200) throw new Error(`queue-start failed: ${queueStart.status} ${queueStart.text}`);

  const queuePayload = JSON.parse(queueStart.text);
  const current = await request('GET', '/api/progress/queue/current', null, { Authorization: `Bearer ${auth.token}` });
  if (current.status !== 200) throw new Error(`current queue failed: ${current.status} ${current.text}`);
  const activeQueue = JSON.parse(current.text).activeQueue;
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

  const second = activeQueue.items[1];
  const wrongAttempt = await request('POST', '/api/progress/queue/attempt', {
    queueId: activeQueue.queueId,
    queueItemId: second.queueItemId,
    mode: 'flashcards',
    correctness: false,
    latencyMs: 5000,
    idempotencyKey: `wrong-${Date.now()}`,
  }, { Authorization: `Bearer ${auth.token}` });
  if (wrongAttempt.status !== 200) throw new Error(`wrong attempt failed: ${wrongAttempt.status} ${wrongAttempt.text}`);

  console.log('smoke test passed');
})();
