// Machine-wide lock so only one agent runs an expensive job (p99 drive, goldens, real-smoke, cargo) at a time.
// CLI:  node browser/heavy-lock.mjs [--label name] -- <command> [args...]   (waits, runs, releases, exits with its code)
// API:  const release = await acquireHeavyLock('label'); try { ... } finally { release(); }
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LOCK_DIR = process.env.HEAVY_LOCK_DIR || join(tmpdir(), 'azeroth-heavy.lock');
const STALE_MS = 25 * 60 * 1000;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function stale() {
  try {
    const o = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8'));
    return !alive(o.pid) || Date.now() - o.at > STALE_MS;
  } catch { return true; }
}

export async function acquireHeavyLock(label = 'job', { poll = 2000, log = console.error } = {}) {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'owner.json'), JSON.stringify({ pid: process.pid, label, cwd: process.cwd(), at: Date.now() }));
      let done = false;
      const release = () => { if (!done) { done = true; rmSync(LOCK_DIR, { recursive: true, force: true }); } };
      process.on('exit', release);
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (stale()) { rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      if (!announced) {
        let who = '';
        try { const o = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')); who = ` (held by "${o.label}" pid ${o.pid} in ${o.cwd})`; } catch {}
        log(`[heavy-lock] waiting for another heavy job${who}`);
        announced = true;
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const sep = args.indexOf('--');
  if (sep < 0 || sep === args.length - 1) { console.error('usage: node heavy-lock.mjs [--label name] -- <command> [args...]'); process.exit(2); }
  const li = args.indexOf('--label');
  const label = li >= 0 && li < sep ? args[li + 1] : args[sep + 1];
  const release = await acquireHeavyLock(label);
  const child = spawn(args[sep + 1], args.slice(sep + 2), { stdio: 'inherit' }); // no shell: wrap real executables (node, cargo), not .cmd shims
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { child.kill(); release(); process.exit(130); });
  child.on('exit', (code) => { release(); process.exit(code ?? 1); });
}
