import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { moonAdt, moonHeightDir } from './moon-terrain.js';

// Golden hash captured from the pre-optimisation generator: the speedup must not change a single byte of Elune terrain.
const x = createHash('sha256');
for (const [tx, ty] of [[0, 0], [3, 5], [8, 8], [20, 31]]) x.update(Buffer.from(moonAdt(0x1e11e, tx, ty)));
assert.equal(x.digest('hex'), 'e12cce5bb9de902ef1dd9cc8d33b63a3e469e39951a3fbcc98e1c8d780e795da');

// Repeated and interleaved queries (memo caches) must stay pure.
const pts = [[1, 0, 0], [0, 1, 0], [0.6, 0.64, 0.48], [0.6, 0.64, 0.48], [1, 0, 0]];
const first = pts.map(p => moonHeightDir(0x1e11e, ...p));
assert.equal(first[0], first[4]);
assert.equal(first[2], first[3]);
assert.deepEqual(pts.map(p => moonHeightDir(0x1e11e, ...p)), first);
console.log('moon-terrain-speed ok');
