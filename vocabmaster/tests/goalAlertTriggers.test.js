const assert = require('assert');
const { evaluateGoalAlertState } = require('../src/services/goalAlertService');

function run() {
  const cases = [
    {
      name: 'marks achieved when actual reaches target',
      goal: { target: 100, metric: 'accuracy' },
      actual: 100,
      expected: 'achieved',
    },
    {
      name: 'marks on track when progress is strong',
      goal: { target: 100, metric: 'accuracy' },
      actual: 80,
      expected: 'on_track',
    },
    {
      name: 'marks at risk when progress is moderate',
      goal: { target: 100, metric: 'accuracy' },
      actual: 50,
      expected: 'at_risk',
    },
    {
      name: 'marks behind when progress is low',
      goal: { target: 100, metric: 'accuracy' },
      actual: 20,
      expected: 'behind',
    },
    {
      name: 'handles zero target safely',
      goal: { target: 0, metric: 'accuracy' },
      actual: 0,
      expected: 'not_started',
    },
  ];

  for (const testCase of cases) {
    const actual = evaluateGoalAlertState(testCase.goal, testCase.actual);
    assert.strictEqual(actual.status, testCase.expected, `${testCase.name}: expected ${testCase.expected}, got ${actual.status}`);
  }

  console.log('goal alert trigger tests passed');
}

run();
