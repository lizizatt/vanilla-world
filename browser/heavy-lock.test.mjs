import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./heavy-lock.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const run = (dir, js) => spawnSync(process.execPath, [script, '--label', 't', '--', process.execPath, '-e', js], { env: { ...process.env, HEAVY_LOCK_DIR: dir }, encoding: 'utf8' });

test('runs the command and releases the lock', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hl-')), 'lock');
  assert.equal(run(dir, 'process.exit(3)').status, 3);
  assert.equal(run(dir, 'process.exit(0)').status, 0);
});

test('reclaims a lock whose owner is dead', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hl-')), 'lock');
  mkdirSync(dir);
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, label: 'dead', cwd: '', at: Date.now() }));
  assert.equal(run(dir, 'process.exit(0)').status, 0);
});
