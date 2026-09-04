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

function runQuizAssertions() {
  const html = readPublicPage('quiz-ultra.html');

  expectRegex(
    html,
    /const\s+pageParams\s*=\s*new\s+URLSearchParams\(window\.location\.search\);/,
    'quiz-ultra should parse URLSearchParams from window.location.search'
  );
  expectRegex(
    html,
    /const\s+requestedTargetLevel\s*=\s*String\(pageParams\.get\('targetLevel'\)\s*\|\|\s*''\)\.trim\(\)\.toUpperCase\(\);/,
    'quiz-ultra should define requestedTargetLevel from URL params'
  );
  expectRegex(
    html,
    /const\s+targetQuestionCount\s*=\s*Math\.max\(0,\s*Math\.min\(30,\s*parseInt\(pageParams\.get\('wordCount'\),\s*10\)\s*\|\|\s*0\)\);/,
    'quiz-ultra should define targetQuestionCount from wordCount URL param'
  );
  expectRegex(
    html,
    /const\s+requestedCount\s*=\s*targetQuestionCount\s*>\s*0\s*\?\s*targetQuestionCount\s*:\s*20;/,
    'quiz-ultra should derive requestedCount from targetQuestionCount'
  );
  expectRegex(
    html,
    /let\s+questions\s*=\s*\[\];/,
    'quiz-ultra should initialize with no local fallback question pool'
  );
  expectRegex(
    html,
    /const\s+item\s*=\s*adaptiveQueue\.consumeQueueItem\(queueResult\.queueId,\s*i\);/,
    'quiz-ultra should consume queue items through adaptiveQueue.consumeQueueItem'
  );
  expectRegex(
    html,
    /await\s+adaptiveQueue\.submitAttempt\(q\.queueMeta\.queueId,\s*\{/,
    'quiz-ultra should submit attempts through adaptiveQueue.submitAttempt'
  );
  expectRegex(
    html,
    /if\s*\(items\.length\)\s*\{\s*questions\s*=\s*items;\s*\}/,
    'quiz-ultra should only set questions from consumed queue items'
  );
}

function runFlashcardsAssertions() {
  const html = readPublicPage('flashcards-ultra.html');

  expectRegex(
    html,
    /const\s+cursor\s*=\s*adaptiveQueue\.getCachedCursor\(\);/,
    'flashcards-ultra should read queue cursor from adaptiveQueue.getCachedCursor()'
  );
  expectRegex(
    html,
    /const\s+start\s*=\s*Math\.max\(0,\s*cursor\.nextIndex\);/,
    'flashcards-ultra should compute cursor start index'
  );
  expectRegex(
    html,
    /const\s+item\s*=\s*adaptiveQueue\.consumeQueueItem\(queueResult\.queueId,\s*i\);/,
    'flashcards-ultra should consume queue items through adaptiveQueue.consumeQueueItem'
  );
  expectRegex(
    html,
    /if\s*\(!queueItems\.length\)\s*return\s*false;/,
    'flashcards-ultra should guard against empty consumed queue items'
  );
  expectRegex(
    html,
    /cards\s*=\s*queueItems\.map\(/,
    'flashcards-ultra should map cards from consumed queue items'
  );
  expectRegex(
    html,
    /await\s+adaptiveQueue\.submitAttempt\(meta\.queueId,\s*\{/,
    'flashcards-ultra should submit attempts through adaptiveQueue.submitAttempt'
  );
}

function runMatchingAssertions() {
  const html = readPublicPage('matching-ultra.html');

  expectRegex(
    html,
    /let\s+pairs\s*=\s*\[\];/,
    'matching-ultra should initialize with no local fallback pairs'
  );
  expectRegex(
    html,
    /const\s+item\s*=\s*adaptiveQueue\.consumeQueueItem\(queueResult\.queueId,\s*i\);/,
    'matching-ultra should consume queue items through adaptiveQueue.consumeQueueItem'
  );
  expectRegex(
    html,
    /await\s+adaptiveQueue\.submitAttempt\(meta\.queueId,\s*\{/,
    'matching-ultra should submit attempts through adaptiveQueue.submitAttempt'
  );
}

function runSpellingAssertions() {
  const html = readPublicPage('spelling-ultra.html');

  expectRegex(
    html,
    /let\s+words\s*=\s*\[\];/,
    'spelling-ultra should initialize with no local fallback words'
  );
  expectRegex(
    html,
    /const\s+item\s*=\s*adaptiveQueue\.consumeQueueItem\(queueResult\.queueId,\s*i\);/,
    'spelling-ultra should consume queue items through adaptiveQueue.consumeQueueItem'
  );
  expectRegex(
    html,
    /await\s+adaptiveQueue\.submitAttempt\(meta\.queueId,\s*\{/,
    'spelling-ultra should submit attempts through adaptiveQueue.submitAttempt'
  );
}

function run() {
  runQuizAssertions();
  runFlashcardsAssertions();
  runMatchingAssertions();
  runSpellingAssertions();
  console.log('ultra queue URL wiring smoke test passed');
}

run();
