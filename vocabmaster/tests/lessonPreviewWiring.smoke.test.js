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

function runBuilderAssertions() {
  const html = readPublicPage('lesson-builder.html');

  expectRegex(
    html,
    /sessionStorage\.setItem\('lessonPreviewData'/,
    'lesson-builder should persist preview payload in sessionStorage'
  );
  expectRegex(
    html,
    /window\.open\('\/lesson-player\.html\?preview=1',\s*'_blank'\)/,
    'lesson-builder should open lesson-player in preview mode'
  );
  expectRegex(
    html,
    /function\s+buildPreviewExercise\(/,
    'lesson-builder should generate preview exercises by type'
  );
}

function runPlayerAssertions() {
  const html = readPublicPage('lesson-player.html');

  expectRegex(
    html,
    /const\s+isPreviewMode\s*=\s*query\.get\('preview'\)\s*===\s*'1';/,
    'lesson-player should detect preview mode from URL'
  );
  expectRegex(
    html,
    /sessionStorage\.getItem\(PREVIEW_STORAGE_KEY\)/,
    'lesson-player should load preview payload from sessionStorage'
  );
  expectRegex(
    html,
    /if\s*\(isPreviewMode\s*\|\|\s*!lessonId\)\s*return;/,
    'lesson-player should skip progress persistence in preview mode'
  );
}

function run() {
  runBuilderAssertions();
  runPlayerAssertions();
  console.log('lesson preview wiring smoke test passed');
}

run();
