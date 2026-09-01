const axios = require('axios');

async function run() {
  const base = process.env.API_BASE || 'http://localhost:3000/api';
  const token = process.env.API_TOKEN || '';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  console.log('Fetching study plan and starting queue (autoStart)...');
  const planResp = await axios.get(base + '/progress/study-plan?autoStart=true', { headers });
  const queueInfo = planResp.data && planResp.data.queue;
  if (!queueInfo) {
    console.error('Failed to auto-start queue; ensure API is reachable and token set.');
    process.exit(1);
  }
  console.log('Started queue', queueInfo.queueId, 'totalItems', queueInfo.totalItems);

  const current = await axios.get(base + '/progress/queue/current', { headers });
  const active = current.data && current.data.activeQueue;
  if (!active || !active.items || !active.items.length) {
    console.error('No active items');
    process.exit(1);
  }

  const first = active.items[0];
  console.log('First item', first.queueItemId, 'position', first.position);

  // Simulate two concurrent attempts with the same idempotencyKey
  const idempotencyKey = 'TEST-' + Date.now();
  const body = {
    queueId: active.queueId,
    queueItemId: first.queueItemId,
    mode: 'quiz',
    correctness: true,
    latencyMs: 400,
    idempotencyKey,
    expectedVersion: active.version,
    expectedPosition: first.position,
  };

  const req = () => axios.post(base + '/progress/queue/attempt', body, { headers }).catch((err) => err.response ? err.response.data : { error: err.message });

  console.log('Sending two concurrent identical attempts...');
  const [r1, r2] = await Promise.all([req(), req()]);
  console.log('Response 1:', r1);
  console.log('Response 2:', r2);

  // Now send two concurrent attempts with different keys
  const b2 = { ...body, idempotencyKey: idempotencyKey + '-A' };
  const b3 = { ...body, idempotencyKey: idempotencyKey + '-B' };
  console.log('Sending two concurrent different-key attempts...');
  const [s1, s2] = await Promise.all([
    axios.post(base + '/progress/queue/attempt', b2, { headers }).catch((err) => err.response ? err.response.data : { error: err.message }),
    axios.post(base + '/progress/queue/attempt', b3, { headers }).catch((err) => err.response ? err.response.data : { error: err.message }),
  ]);
  console.log('Different-key responses:', s1, s2);
}

run().catch((err) => { console.error(err); process.exit(1); });
