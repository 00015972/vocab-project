'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

function listTestFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function runNodeFile(filePath) {
  const result = spawnSync(process.execPath, [filePath], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  return Number(result.status || 0);
}

function main() {
  const testFiles = listTestFiles(testsDir);
  if (!testFiles.length) {
    console.error('No test files found in tests/.');
    process.exit(1);
  }

  const failed = [];

  for (const testFile of testFiles) {
    const label = path.relative(rootDir, testFile).replace(/\\/g, '/');
    console.log(`\n=== RUN ${label} ===`);
    const code = runNodeFile(testFile);
    if (code !== 0) {
      failed.push(label);
    }
  }

  if (failed.length) {
    console.error('\nFAILED TEST FILES:');
    failed.forEach((name) => console.error(`- ${name}`));
    process.exit(1);
  }

  console.log('\nALL TEST FILES PASSED');
}

main();
