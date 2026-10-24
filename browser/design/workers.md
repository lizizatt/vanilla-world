# Design: workers

Status: recommendation (no code changed). Inputs: `world-worker*.js`, `world-engine.js`, `asset-worker.js`, `far-worker.js`, `world-client.js`, `asset-channel.js`, `far-channel.js`.

## Recommendation: keep three domain workers, share one RPC layer
Keep `world`, `asset` and `far` workers as separate isolates. Add a dependency-light `worker-rpc.js` that owns the transport mechanics all three hand-code today:
- discriminated message types with `{v, id, op}` / `{v, id, ok, result|error}` / `{v, event, ...}` envelopes;
- request-id tables, `ack`, cancellation, epoch/stale rejection;
- transfer-list declaration;
- one lifecycle state machine, `new -> opening -> ready -> closing -> closed`, which settles every pending promise on close.

Domain payload schemas stay in each domain. Entry points stay thin adapters.

Also remove the world -> far relay (`world-engine` proxying far traffic) by letting main talk to `far-worker` directly. The world worker keeps only a "far-ack" notification.

## Rejected: one consolidated worker pool
Pros: one lifecycle, one scheduler. Cons that decided it:
- physics/scene latency would compete with MPQ decode and far WDL reads (the 64-job/64-MiB asset budgets and the serialized far read budget are deliberate);
- larger crash blast radius;
- priority-inversion risk and a harder-to-reason scheduler;
- the duplication is plumbing, which a shared helper removes without merging isolates.
Revisit only if telemetry shows worker boot/teardown or transfer cost dominating.

## Migration (each step shippable, behaviour-preserving)
1. Add `worker-rpc.js` constants/schema plus golden-message fixtures captured from current traffic; no runtime change.
2. Convert asset channel/worker (keep queue priority, 64-job/64-MiB limits, cancel, ack, transfers).
3. Convert far channel/worker (keep epoch + single-read budget).
4. Convert `WorldClient`/`world-worker-protocol` (keep immediate routing, frame coalescing, pose handling).
5. Route main <-> far directly; delete the relay.
6. Contract tests: malformed/duplicate/stale replies, close mid-operation, transfer ownership, version mismatch.

## Risks
Accidental transfer-list or cancellation-timing changes; lifecycle leaks. Mitigate with golden fixtures and benchmarks.

## Success
Identical smoke/test results, zero unresolved promises after termination, bounded queues, no cross-domain protocol imports, unchanged drive p99.
