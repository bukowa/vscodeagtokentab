import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TranscriptTailer } = require('../out/transcriptTailer.js');
const { ConversationFinder } = require('../out/conversationFinder.js');

const TEST_DIR = path.resolve('test', 'fixtures_temp');

function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

test.beforeEach(() => {
  setupTestDir();
});

test.after(() => {
  cleanupTestDir();
});

test('TranscriptTailer tails PLANNER_RESPONSE entries and computes context tokens', async () => {
  const logFile = path.join(TEST_DIR, 'transcript.jsonl');
  fs.writeFileSync(logFile, '');

  const tailer = new TranscriptTailer(logFile);
  const entries = [];

  tailer.on('entry', (entry) => {
    entries.push(entry);
  });

  await tailer.start();

  const line1 = JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    content: 'Hello Antigravity',
  }) + '\n';

  const line2 = JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    input_tokens: 3200,
    cache_read_tokens: 28000,
    output_tokens: 150,
  }) + '\n';

  fs.appendFileSync(logFile, line1);
  fs.appendFileSync(logFile, line2);

  await tailer.readNewBytes();

  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'USER_INPUT');
  assert.equal(entries[1].type, 'PLANNER_RESPONSE');
  assert.equal(entries[1].input_tokens, 3200);
  assert.equal(entries[1].cache_read_tokens, 28000);

  const totalContext = entries[1].input_tokens + entries[1].cache_read_tokens;
  assert.equal(totalContext, 31200);

  tailer.dispose();
});

test('ConversationFinder finds active conversation for current workspace', async () => {
  const finder = new ConversationFinder([{ fsPath: process.cwd() }]);
  const active = await finder.findActive();
  if (!active) {
    // Brain dir or active conversation may be absent in a test environment; skip gracefully
    return;
  }
  assert.ok(active.conversationId, 'Active conversation has an ID');
  assert.ok(fs.existsSync(active.transcriptPath), 'Transcript path exists on disk');
});

test('ConversationFinder returns null when workspace does not match', async () => {
  const nonExistentWorkspace = 'c:\\projects\\non_existent_random_directory_xyz_12345';
  const finder = new ConversationFinder([{ fsPath: nonExistentWorkspace }]);
  const result = await finder.findActive();
  assert.equal(result, null, 'Should return null for non-matching workspace');
});
