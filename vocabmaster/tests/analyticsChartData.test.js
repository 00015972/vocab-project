const assert = require('assert');
const { buildChartDataFromHistory } = require('../src/utils/analytics');

function run() {
  const rows = [
    { dateKey: '2024-09-01', xpEarned: 120, avgAccuracy: 78 },
    { dateKey: '2024-09-02', xpEarned: 80, avgAccuracy: 84 },
  ];

  const xpSeries = buildChartDataFromHistory(rows, 'xp');
  const accuracySeries = buildChartDataFromHistory(rows, 'accuracy');

  assert.strictEqual(xpSeries[0].label, '09-01');
  assert.strictEqual(xpSeries[0].value, 120);
  assert.strictEqual(accuracySeries[1].value, 84);

  console.log('analytics chart data tests passed');
}

run();
