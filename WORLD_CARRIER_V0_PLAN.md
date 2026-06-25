# World Carrier v0 Implementation Plan

## Summary
Build `world-host` as World Carrier v0: a zero-runtime-dependency ESM reference host where `Application identity + authoritative TurnClosure + persisted effect outcomes` is the complete recoverable process. The chosen path is store-first and proof-first: first pin released World v0.1.0 artifacts and implement immutable blobs, branch heads, codecs, and effect records; then add disposable workers, RunController, drivers, migration/branching, CLI, examples, and conformance. Done means `node --test`, all Carrier conformance scripts, flagship file rewrite crash variants, A to B migration, branch divergence, and the World prerequisite commands pass with no World dependency on `world-host`.

Execution stays in a new repository. `world-host` consumes released `world_universal_appliance.wasm`, one sealed `Executable.Image`, latest committed `TurnClosure` or genesis, persisted host effect outcomes, and receiver-local drivers/policy. A warm worker is always a cache; RunHead is the mutable authority; immutable World-authored bytes and host effect outcomes are never edited in place.

## Non-Goals/Out of Scope
No changes to World core semantics. Do not add filesystem storage, networking, HTTP, model clients, file actuators, worker pools, schedulers, process supervision, host locking, package discovery, service discovery, credentials, or host configuration to `tkersey/world`.

Out of scope for Carrier v0: database engines, xitdb, SQLite, LMDB, hidden cloud service, distributed consensus, network filesystem durability claims, multi-process writers, multi-writer branch heads, remote Carrier transport, branch merge, shell-command driver, arbitrary process execution, credential storage in World bytes, exactly-once claims, cryptographic authenticity, confidentiality, signing, encryption, hostile-host protection, malicious-runtime protection, browser production persistence, and live `Executable.Image` upgrade.

## Interfaces/Types/APIs Impacted
- Core records: `Carrier`, `Application`, `Run`, `Branch`, `RunHead`, `ClosureRecord`, `ApplicationRecord`, `CarrierManifest`, `CarrierExport`, `CarrierProofBundle`.
- Store API: `putBlob(bytes)`, `getBlob(ref)`, `hasBlob(ref)`, `createApplication(record)`, `getApplication(id)`, `createRun(record)`, `getRun(id)`, `readHead(runId, branchId)`, `compareAndSwapHead(runId, branchId, expectedGeneration, nextHead)`, `putEffectRecord(record)`, `getEffectRecord(runId, idempotencyKey)`, `listEffectRecords(runId)`, `exportRun(runId, branchId)`, `importRun(bundle)`.
- Effect API: `EffectJournal`, `EffectRecord`, `EffectState`, `EffectRecoveryClass`, full World `IdempotencyKey` bytes, request bytes checksum, optional `ResolutionInput` ref, optional host claim ref, optional driver transaction ref.
- Driver API: `manifest() -> DriverManifest`, `resolve(context, hostRequest) -> ResolutionInput`, optional `recover`, `query`, `cancel`; routing uses exact `ActuatorRef`, descriptor fingerprint, Actuation class, and response schema.
- Worker API: `instantiate`, `readRuntimeManifest`, `loadExecutable`, `readApplianceManifest`, `submitTurn`, `readTurnClosure`, `reset`, `unload`, `dispose`; validate zero imports, ABI version, memory bounds, and copy output before any mutating call.
- CLI: `install`, `doctor`, `run`, `resume`, `inspect`, `effects`, `recover`, `fork`, `export`, `import`, plus `run-example` for file rewrite, crash recovery, migration, and branching.
- File layout: use `src/core`, `src/stores`, `src/drivers`, `src/node`, `src/protocol`, `bin`, `examples`, and `test`; Node-only behavior stays in `src/node` and `src/stores/directory_store.mjs`.

## Data Flow
1. Install application: verify pinned universal WASM checksum, read runtime/Appliance manifests, load sealed `Executable.Image`, record World fingerprints, required actuators, runtime limits, and diagnostics in `ApplicationRecord`.
2. Create/resume run: create `Run` and initial `Branch`; `RunHead` points to genesis or committed `TurnClosure`; effect journal namespace is run and branch aware.
3. Advance branch: acquire in-process branch ownership, read head, load parent closure, preflight receiver-local capability/policy, obtain worker, boot or cold restore, inspect pending `HostRequest`s, resolve available effects through journal and drivers, persist every `ResolutionInput`, submit one canonical `TurnInput`, persist next closure and required Archive batch, CAS head, finalize effect states.
4. Recover: ignore incomplete temp files, scan heads/effects, reuse persisted `ResolutionInput`, query/recover driver state where supported, require operator intervention for unrecoverable `best_effort`, and never advance from a blob alone.
5. Migrate/fork: export exact immutable bytes and relevant effect outcomes; receiver verifies checksums/protocol/image/closure, re-preflights local policy, imports blobs, creates receiver-local run/branch ids, and resumes without carrying authority.

## Edge Cases/Failure Modes
- Crash before effect claim or before execution: parent head remains authoritative; request can retry.
- Crash during/after effect before `ResolutionInput` persistence: automatic recovery only for pure/idempotent/externally_recoverable/transactional drivers; `best_effort` requires operator decision.
- Crash after `ResolutionInput` persistence but before closure persistence: reuse persisted `ResolutionInput`; do not repeat external effect.
- Crash after closure persistence but before head CAS: parent head remains authoritative; closure is an orphan candidate unless CAS later succeeds.
- Crash after head update before effect finalization: next head is authoritative; reconcile effect state from committed closure.
- CAS conflict: preserve produced closure as orphan candidate, report branch conflict, never merge histories silently.
- Same idempotency key with different request bytes: hard conflict; matching shortened hashes is forbidden.
- Stale lock: do not silently break by wall time; require explicit operator recovery or documented safe policy.
- Worker identity mismatch: discard warm worker or cold restore when application id, branch head closure, expected state fingerprint, or turn sequence differ.

## Tests/Acceptance
- World prerequisite: run `zig build check-world-v0`, `zig build world-universal-appliance-wasm`, record universal WASM SHA-256, and verify World v0.1.0 artifact versions before Carrier release.
- Carrier commands: run `node --version`, `node --test`, `npm test` only as zero-dependency alias, `node scripts/run-world-conformance.mjs`, `node scripts/run-store-conformance.mjs`, `node scripts/run-crash-matrix.mjs`, `node scripts/run-migration-conformance.mjs`, `node scripts/run-security-conformance.mjs`.
- Store acceptance: MemoryStore and DirectoryStore pass immutable blob roundtrip, checksum mismatch, head create, CAS success/conflict, orphan blob, partial head file, restart recovery, import/export, exclusive lock, stale lock handling.
- Effect acceptance: full-key equality, conflict on same key/different request, persisted outcome reuse, pure/idempotent/external/transactional recovery, `best_effort` intervention, partial batches, no duplicate idempotent write.
- Flagship acceptance: `world-host run-example file-rewrite-agent` proves sandbox read/write, deterministic fixture model, final file content `world carrier updated the fixture`, root-result bytes, TurnReceipt, Archive.AppendBatch retention, restart inspection without World execution, and crash variants.

## Implementation Brief
1. step=repository_and_artifact_foundation; owner=implementation; success_criteria=`world-host` ESM package has zero runtime dependencies, requested layout, pinned World v0.1.0 metadata, universal WASM checksum, ABI/TurnClosure/Boundary version constants, protocol codec imports/tests, and proof that World does not depend on `world-host`.
2. step=storage_authority_kernel; owner=implementation; success_criteria=core records, BlobRef/World fingerprint separation, ClosureStore, MemoryStore, DirectoryStore temp-write/rename/checksum/CAS/lock/recovery/import-export pass store conformance.
3. step=effect_authority_kernel; owner=implementation; success_criteria=EffectJournal, EffectRecord states, recovery classes, full idempotency key conflict rules, persisted `ResolutionInput` reuse, and `best_effort` intervention pass effect conformance.
4. step=worker_and_controller; owner=implementation; success_criteria=WorldWorker validates zero imports/ABI/memory, RunController advances one branch with one canonical turn submission, batches resolutions, preserves orphan closures on CAS conflict, and passes worker/crash lanes.
5. step=capability_preflight_and_drivers; owner=implementation; success_criteria=HostCapabilityManifest, CapabilityReport, RunPolicy, FixtureModelDriver, SandboxFileDriver, HttpJsonDriver, authority checks, redaction, traversal/origin/size tests pass.
6. step=migration_branching_cli_diagnostics; owner=implementation; success_criteria=`fork/export/import/inspect/effects/recover` work, receiver policy re-preflight is enforced, branch histories diverge without merge, and `CarrierProofBundle` is emitted for proof runs.
7. step=examples_docs_distribution_closeout; owner=implementation; success_criteria=file rewrite, crash recovery, migration, and branching examples pass; security/migration docs and `world-host-v0/` package are complete; all proof commands pass; PR summary covers every required explanation and non-goal.

## Required Proof
- `zig build check-world-v0`
- `zig build world-universal-appliance-wasm`
- `node --version`
- `node --test`
- `node scripts/run-world-conformance.mjs`
- `node scripts/run-store-conformance.mjs`
- `node scripts/run-crash-matrix.mjs`
- `node scripts/run-migration-conformance.mjs`
- `node scripts/run-security-conformance.mjs`
- `world-host run-example file-rewrite-agent`
- `world-host run-example crash-recovery`
- `world-host run-example migration`
- `world-host run-example branching`
- prove no npm runtime dependency, no Zig helper process, no child-process protocol encoding, one idempotent effect invocation across lost-output retry, byte-identical retry closure, A to B migration, independent branches, DirectoryStore restart head recovery, and no World dependency on `world-host`.
