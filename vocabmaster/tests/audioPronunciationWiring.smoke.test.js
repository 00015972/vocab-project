'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function expectRegex(content, regex, message) {
  assert.ok(regex.test(content), message);
}

function run() {
  const lessonPlayer = readFile('public/lesson-player.html');
  expectRegex(
    lessonPlayer,
    /fetch\('\/api\/audio\/check-pronunciation'/,
    'lesson-player should call /api/audio/check-pronunciation'
  );

  const server = readFile('server.js');
  expectRegex(
    server,
    /app\.use\('\/api\/audio',\s*require\('\.\/src\/routes\/audio'\)\);/,
    'server should mount /api/audio route'
  );

  const audioRoute = readFile('src/routes/audio.js');
  expectRegex(
    audioRoute,
    /router\.post\('\/check-pronunciation'/,
    'audio route should expose POST /check-pronunciation'
  );

  console.log('audio pronunciation wiring smoke test passed');
}

run();
