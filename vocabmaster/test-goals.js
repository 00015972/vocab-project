#!/usr/bin/env node
/**
 * Goals & Alerts Feature — Comprehensive Test Suite
 */
const http = require('http');
let pass = 0, fail = 0;

function assert(cond, msg) {
  if (cond) { console.log('  ✓', msg); pass++; }
  else       { console.log('  ✗', msg); fail++; }
}

async function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://localhost:3000');
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    };
    const r = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(d) }); }
        catch { resolve({ s: res.statusCode, b: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function run() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║     GOALS & ALERTS — FULL TEST SUITE               ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Auth
  const login = await req('POST', '/api/auth/login', {
    email: 'creator@test.local', password: 'Creator123!',
    role: 'creator', creatorPortalCode: 'creator123'
  });
  const token = login.b.token;
  const auth = { Authorization: 'Bearer ' + token };
  assert(!!token, 'Creator authenticated');

  // Always start clean — remove any leftover goals from prior runs
  const listCleanup = await req('GET', '/api/creator/goals', null, auth);
  for (const g of listCleanup.b.goals || []) {
    await req('DELETE', `/api/creator/goals/${g._id}`, null, auth);
  }

  // ── SUITE 1: CRUD ────────────────────────────────────────
  console.log('\nSUITE 1: Goals CRUD');

  const list0 = await req('GET', '/api/creator/goals', null, auth);
  assert(list0.s === 200, 'GET /goals returns 200');
  assert(Array.isArray(list0.b.goals), 'Response has goals array');

  // Create
  const c1 = await req('POST', '/api/creator/goals', { label: 'Accuracy goal', metric: 'accuracy', target: 80, timeframe: 'monthly' }, auth);
  assert(c1.s === 201, 'POST /goals returns 201');
  assert(c1.b.goal?._id, 'Created goal has _id');
  assert(c1.b.goal?.label === 'Accuracy goal', 'Label stored correctly');
  assert(c1.b.goal?.metric === 'accuracy', 'Metric stored correctly');
  assert(c1.b.goal?.target === 80, 'Target stored correctly');
  assert(c1.b.goal?.timeframe === 'monthly', 'Timeframe stored correctly');
  const gid = c1.b.goal._id;

  // Update
  const u1 = await req('PUT', `/api/creator/goals/${gid}`, { label: 'Updated accuracy goal', target: 90 }, auth);
  assert(u1.s === 200, 'PUT /goals/:id returns 200');
  assert(u1.b.goal?.label === 'Updated accuracy goal', 'Label updated');
  assert(u1.b.goal?.target === 90, 'Target updated');

  // List after create
  const list1 = await req('GET', '/api/creator/goals', null, auth);
  assert(list1.b.goals.some(g => g._id === gid), 'Goal appears in list');

  // Delete
  const del = await req('DELETE', `/api/creator/goals/${gid}`, null, auth);
  assert(del.s === 200, 'DELETE /goals/:id returns 200');
  const list2 = await req('GET', '/api/creator/goals', null, auth);
  assert(!list2.b.goals.some(g => g._id === gid), 'Goal removed from list');

  // ── SUITE 2: VALIDATION ──────────────────────────────────
  console.log('\nSUITE 2: Validation & Error Handling');

  const noLabel = await req('POST', '/api/creator/goals', { metric: 'accuracy', target: 80, timeframe: 'monthly' }, auth);
  assert(noLabel.s === 400, 'Missing label → 400');

  const badMetric = await req('POST', '/api/creator/goals', { label: 'x', metric: 'invalid', target: 80, timeframe: 'monthly' }, auth);
  assert(badMetric.s === 400, 'Invalid metric → 400');

  const badTarget = await req('POST', '/api/creator/goals', { label: 'x', metric: 'accuracy', target: -5, timeframe: 'monthly' }, auth);
  assert(badTarget.s === 400, 'Negative target → 400');

  const badTimeframe = await req('POST', '/api/creator/goals', { label: 'x', metric: 'accuracy', target: 80, timeframe: 'decade' }, auth);
  assert(badTimeframe.s === 400, 'Invalid timeframe → 400');

  const noAuth = await req('GET', '/api/creator/goals');
  assert(noAuth.s === 401, 'No auth → 401');

  const notFound = await req('DELETE', '/api/creator/goals/nonexistent000', null, auth);
  assert(notFound.s === 404, 'Delete non-existent → 404');

  // ── SUITE 3: PROGRESS COMPUTATION ───────────────────────
  console.log('\nSUITE 3: Goal Progress Computation');

  // Create test goals for each metric
  const metrics = [
    { label: 'Test accuracy', metric: 'accuracy', target: 80, timeframe: 'monthly' },
    { label: 'Test XP', metric: 'avgXP', target: 200, timeframe: 'allTime' },
    { label: 'Test sessions', metric: 'sessions', target: 2, timeframe: 'monthly' },
    { label: 'Test streak', metric: 'streak', target: 3, timeframe: 'allTime' },
    { label: 'Test active rate', metric: 'activeRate', target: 50, timeframe: 'weekly' },
  ];
  const createdIds = [];
  for (const m of metrics) {
    const r = await req('POST', '/api/creator/goals', m, auth);
    if (r.b.goal?._id) createdIds.push(r.b.goal._id);
  }

  const prog = await req('GET', '/api/creator/goals/progress', null, auth);
  assert(prog.s === 200, 'GET /goals/progress returns 200');
  assert(Array.isArray(prog.b.goalsProgress), 'Response has goalsProgress array');
  assert(prog.b.goalsProgress.length === metrics.length, `Progress returned for all ${metrics.length} goals`);

  prog.b.goalsProgress.forEach(function(g) {
    assert(typeof g.actual === 'number', `[${g.metric}] actual is a number (${g.actual})`);
    assert(typeof g.pct === 'number', `[${g.metric}] pct is a number (${g.pct})`);
    assert(['achieved','on_track','at_risk','behind','not_started'].includes(g.status), `[${g.metric}] status is valid (${g.status})`);
    assert(g.unit !== undefined, `[${g.metric}] unit is present`);
  });

  // Accuracy: demo has 87% accuracy, target 80 → should be "achieved"
  const accGoal = prog.b.goalsProgress.find(g => g._id === createdIds[0]);
  assert(accGoal?.actual === 87, `Accuracy actual is 87 (got ${accGoal?.actual})`);
  assert(accGoal?.status === 'achieved', `Accuracy goal is "achieved" (actual 87 >= target 80)`);

  // XP: demo has 250 avg XP, target 200 → achieved
  const xpGoal = prog.b.goalsProgress.find(g => g._id === createdIds[1]);
  assert(xpGoal?.actual === 250, `avgXP actual is 250 (got ${xpGoal?.actual})`);
  assert(xpGoal?.status === 'achieved', `XP goal is "achieved" (250 >= 200)`);

  // Active rate: 1/1 student active = 100%, target 50 → achieved
  const arGoal = prog.b.goalsProgress.find(g => g._id === createdIds[4]);
  assert(arGoal?.actual === 100, `activeRate is 100% (got ${arGoal?.actual})`);

  // pct cap test — pct should not exceed 999 (Math.min applied server-side)
  const pctsOk = prog.b.goalsProgress.every(g => g.pct <= 999);
  assert(pctsOk, 'pct values are capped at 999');

  // Cleanup test goals
  for (const id of createdIds) {
    await req('DELETE', `/api/creator/goals/${id}`, null, auth);
  }
  const listClean = await req('GET', '/api/creator/goals', null, auth);
  assert(listClean.b.goals.length === 0, 'Cleanup: all test goals deleted');

  // ── SUITE 4: STATUS LOGIC ────────────────────────────────
  console.log('\nSUITE 4: Status Classification Logic');

  // Create goal where actual is above target → achieved
  const hiGoal = await req('POST', '/api/creator/goals', { label: 'Hi goal', metric: 'accuracy', target: 50, timeframe: 'allTime' }, auth);
  const hiProg = await req('GET', '/api/creator/goals/progress', null, auth);
  const hiGp = (hiProg.b.goalsProgress || []).find(g => g._id === hiGoal.b.goal?._id);
  assert(hiGp?.status === 'achieved', `actual(87) >= target(50) → achieved`);
  assert(hiGp?.pct >= 100, `pct >= 100 for achieved goal`);
  await req('DELETE', `/api/creator/goals/${hiGoal.b.goal?._id}`, null, auth);

  // on_track: target that puts us at ~80%
  const onGoal = await req('POST', '/api/creator/goals', { label: 'On track goal', metric: 'accuracy', target: 100, timeframe: 'allTime' }, auth);
  const onProg = await req('GET', '/api/creator/goals/progress', null, auth);
  const onGp = (onProg.b.goalsProgress || []).find(g => g._id === onGoal.b.goal?._id);
  assert(onGp?.status === 'on_track', `actual(87) / target(100) = 87% → on_track`);
  await req('DELETE', `/api/creator/goals/${onGoal.b.goal?._id}`, null, auth);

  // at_risk: actual/target ~50%
  const ariskGoal = await req('POST', '/api/creator/goals', { label: 'At risk goal', metric: 'accuracy', target: 180, timeframe: 'allTime' }, auth);
  const ariskProg = await req('GET', '/api/creator/goals/progress', null, auth);
  const ariskGp = (ariskProg.b.goalsProgress || []).find(g => g._id === ariskGoal.b.goal?._id);
  assert(ariskGp?.status === 'at_risk', `actual(87) / target(180) = 48% → at_risk`);
  await req('DELETE', `/api/creator/goals/${ariskGoal.b.goal?._id}`, null, auth);

  // behind: actual/target < 40%
  const behindGoal = await req('POST', '/api/creator/goals', { label: 'Behind goal', metric: 'accuracy', target: 300, timeframe: 'allTime' }, auth);
  const behindProg = await req('GET', '/api/creator/goals/progress', null, auth);
  const behindGp = (behindProg.b.goalsProgress || []).find(g => g._id === behindGoal.b.goal?._id);
  assert(behindGp?.status === 'behind', `actual(87) / target(300) = 29% → behind`);
  await req('DELETE', `/api/creator/goals/${behindGoal.b.goal?._id}`, null, auth);

  // ── SUITE 5: ALL METRICS ────────────────────────────────
  console.log('\nSUITE 5: All Metric Types Return Valid Data');

  const allMetrics = ['accuracy', 'avgXP', 'sessions', 'streak', 'activeRate', 'wordsLearned'];
  const created2 = [];
  for (const m of allMetrics) {
    const r = await req('POST', '/api/creator/goals', { label: m + ' goal', metric: m, target: 1, timeframe: 'allTime' }, auth);
    created2.push(r.b.goal?._id);
  }
  const allProg = await req('GET', '/api/creator/goals/progress', null, auth);
  for (const m of allMetrics) {
    const gp = allProg.b.goalsProgress.find(g => g.metric === m);
    assert(gp !== undefined, `Metric "${m}" returned in progress`);
    assert(typeof gp?.actual === 'number', `Metric "${m}" actual is numeric (${gp?.actual})`);
  }
  for (const id of created2.filter(Boolean)) {
    await req('DELETE', `/api/creator/goals/${id}`, null, auth);
  }

  // ── SUMMARY ──────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║                  TEST RESULTS                       ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`\nTotal: ${pass + fail}  ✓ Passed: ${pass}  ✗ Failed: ${fail}`);
  console.log(`Success Rate: ${(pass / (pass + fail) * 100).toFixed(1)}%\n`);
  if (fail === 0) console.log('🎉 ALL TESTS PASSED!\n');
  else {
    console.log('❌ FAILURES DETECTED — review above\n');
    process.exit(1);
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
