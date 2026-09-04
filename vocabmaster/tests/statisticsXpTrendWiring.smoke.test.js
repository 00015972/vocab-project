'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readPublicPage(name) {
  const filePath = path.join(__dirname, '..', 'public', name);
  return fs.readFileSync(filePath, 'utf8');
}

function expectRegex(content, regex, message) {
  assert.ok(regex.test(content), message);
}

function run() {
  const html = readPublicPage('statistics-ultra.html');

  assert.ok(!/XP Trend Coming Soon/.test(html), 'statistics-ultra should not show "XP Trend Coming Soon" placeholder text');

  expectRegex(
    html,
    /function\s+renderXpTrendInsights\(/,
    'statistics-ultra should define XP trend insight renderer'
  );

  expectRegex(
    html,
    /function\s+renderAccuracyTrendInsights\(/,
    'statistics-ultra should define accuracy trend insight renderer'
  );

  expectRegex(
    html,
    /renderXpTrendInsights\(xpSeries\);/,
    'statistics-ultra should render XP trend insights from chart series'
  );

  expectRegex(
    html,
    /renderAccuracyTrendInsights\(accuracySeries\);/,
    'statistics-ultra should render accuracy trend insights from chart series'
  );

  console.log('statistics xp trend wiring smoke test passed');
}

run();
