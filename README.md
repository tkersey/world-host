# world-host

World Carrier v0 is a reference host for long-lived World applications. It treats:

```text
application identity + authoritative TurnClosure + persisted effect outcomes
```

as the complete recoverable process. A warm JavaScript object, WASM instance, file descriptor, process id, request token, allocator, or worker assignment is never authoritative.

This repository owns host concerns only: storing World-authored bytes, choosing the active branch head, invoking local drivers, recording host outcomes, running disposable WASM workers, recovery, migration, and operator tooling. World core stays closed.

## Current Surface

World Application Host v1 is present as a disjoint profile under `src/v1/`. It
admits application-specific, import-free World WASM; validates canonical
ApplicationManifest, StepInput, EffectRequest, EffectResult, and Frame bytes;
continues on disposable workers; persists EffectResults before submission;
retains child Frames before conditional head advancement; and proves retry,
migration, and branching against the real World one-effect artifact. Both
in-memory and directory-backed stores are implemented. The explicit
`world-host app` CLI installs, runs, resumes, inspects, forks, exports, and
imports v1 applications. Carrier v0 remains the default unqualified profile
until cutover.

`bun run build:agent-runtime-v1` assembles the standalone development pack from
the current World application artifacts, v1 host, and v1 capability protocol.
`bun run check:agent-runtime-v1` validates its checksums, manifests,
zero-import/bounded-memory WASMs, and static capability declarations without
executing adapters. `bun run conformance:agent-runtime-v1` runs the six required
behavioral scenarios using only files inside the pack. See
[`docs/agent_runtime_v1_pack.md`](docs/agent_runtime_v1_pack.md).

`world-host app install --store STORE --name APP --wasm application.world.wasm`
validates the zero-import ABI and records the WASM and embedded manifest as
immutable blocks. `world-host app run --store STORE --app APP --run RUN
--initial-args args.bin` creates a Frame lineage. `world-host app resume
--store STORE --run RUN --effect-result result.bin` persists the result before
submitting it to a fresh worker. The CLI reports identities, statuses, counters,
and byte lengths; it does not print application state, payload, result, or
secret bytes.

This repository contains the Carrier v0 host boundary: immutable blob stores, mutable branch heads, effect journal recovery classes, disposable worker/controller contracts, receiver-local capability preflight, constrained reference drivers, migration/fork helpers, redacted CLI diagnostics, deterministic examples, dependency-free World JS codecs, and a Bun WebAssembly worker for the universal Appliance ABI.

`bun scripts/run-world-conformance.mjs --world-repo ../world` executes real World universal Appliance fixture images through Carrier's `BunWorldWorker` and protocol codecs. It also boots a no-host fixture through `RunController` and `MemoryStore`, verifies that the committed branch head points at the same immutable TurnClosure bytes returned by the real worker, then proves a completed head is rejected before a fresh worker is created. The same lane boots a needs-host fixture and lets `RunController` inspect the parent TurnClosure, resolve the real HostRequest through `EffectJournal`, persist the untrusted ResolutionInput before World submission, reuse that persisted outcome on a lost-output retry without invoking the deterministic driver again, and commit the completed TurnClosure. For closures with multiple pending HostRequests, the controller groups requests by exact driver and recovery class, enforces bounded driver concurrency, persists each outcome independently, and constructs one continue TurnInput through the released wire codec so host completion order is not authoritative. Missing driver coverage remains fail-closed by default; a receiver-local `allowPartialEffectBatch` policy may submit only covered persisted outcomes and record unresolved request diagnostics. The deterministic examples still prove Carrier host behavior around stores, effects, migration, and branching; the real World fixture lane is the proof that the worker/codecs/controller can produce, continue from persisted host outcomes, reject terminal heads, and commit World-authored TurnClosure bytes, root result bytes, and Archive append evidence without a native helper process.

`bun bin/world-host.mjs run-example file-rewrite-agent` is a durable host-level flagship fixture. It creates a temporary `DirectoryStore`, installs application/run/head records and immutable blobs, resolves real sandbox file read/write requests through `EffectJournal`, retries the write by the same full World idempotency key without invoking the file driver again, commits the final host branch head, then reopens the store and inspects the completed run, effects, output file, closure blob, and retained archive-append fixture bytes without executing a driver. It is explicit host evidence only; World semantic TurnReceipt/root-result validation remains in the real World conformance lane above.

`bun run proof:agent` runs the Agent Closure host proof. It first validates the sibling World `dist-world-agent-v0` gate, then exercises Carrier-side skeleton, fixture file rewrite, replay, retry, migration, branching, and negative lanes. The agent loop remains Boundary/World-owned; world-host only installs the image, resolves external model/file HostRequests through deterministic drivers, persists `ResolutionInput` bytes, advances retained branch heads, and inspects stored results.

`bun scripts/build-agent-runtime-pack.mjs` creates an `agent-runtime-v0.1/` release-candidate pack with an `AgentRuntime.Manifest`, owner-exported Boundary/World bytes, world-host carrier files, conformance corpus, fixtures, docs, and `checksums.sha256`. `bun scripts/run-agent-runtime-conformance.mjs ./agent-runtime-v0.1` verifies the pack checksums, compiles the distributed universal WASM, runs the carrier skeleton/fixture/replay/retry/migration/branching/negative lanes, and emits Agent Runtime conformance booleans without cloning Boundary or World at conformance time.

`RunController` can advance a branch from real worker output by inspecting World-authored TurnClosure bytes for the next `RunHead` fingerprints. That inspection is host metadata extraction only; Carrier does not validate or author World receipts, capsules, archive moments, chronicle events, or TurnClosures.

If a host dies after advancing `RunHead` but before finalizing effect records, `EffectJournal` can reconcile `submitted` records from the committed head's parent TurnClosure fingerprint. This recovery only marks matching run/branch effects `closure_committed`; it does not rerun drivers or create World evidence.

`world-host inspect --store STORE_DIR --run RUN_ID --branch BRANCH_ID --json` and `world-host effects --store STORE_DIR --run RUN_ID --json` read persisted `DirectoryStore` records for operator diagnostics. They summarize run/head/effect state, closure byte size, and effect state counts without executing a worker, invoking drivers, mutating heads, or printing complete idempotency key bytes. The output is redacted operational JSON, not World semantic encoding.

`world-host recover --store STORE_DIR --json` acquires the `DirectoryStore` lock and reports recovery-scanner diagnostics: ignored temporary files, orphan blobs, no garbage collection, and no multi-process writer support. With `--run RUN_ID --branch BRANCH_ID`, it also reconciles same-branch `submitted` effects to `closure_committed` from the committed head's parent TurnClosure fingerprint. It does not execute a worker, invoke drivers, mutate `RunHead`, fabricate World evidence, silently break locks, garbage collect blobs, or print complete idempotency key bytes.

`world-host fork --store STORE_DIR --run RUN_ID --from CLOSURE --branch NEW_BRANCH --source-branch SOURCE_BRANCH --json` creates an explicit branch head at the selected stored closure without mutating the source branch or merging histories. `world-host export --store STORE_DIR --run RUN_ID --branch BRANCH_ID --out PACKAGE.json --json` writes a local `CarrierExport-v0` package containing exact immutable blob bytes, release identity, selected run/branch, and `authorityCarried: false`. `world-host import --store STORE_DIR --package PACKAGE.json --run NEW_RUN_ID --json` imports that package into a receiver-local run id after receiver-local preflight and reports `authorityImported: false`.

`world-host install --store STORE_DIR --name APP --wasm world_universal_appliance.wasm --image app.world-executable --image-fingerprint WORLD_FINGERPRINT --json` writes the supplied universal WASM and Executable.Image bytes as immutable blobs and creates an `ApplicationRecord`. The universal WASM field is a host SHA-256 checksum; the Executable.Image World fingerprint must be supplied explicitly and is not derived from SHA-256. If `--manifest` is omitted, Carrier stores a host-generated install-summary blob for diagnostics only. Install does not create a run, execute a worker, invoke drivers, carry authority, or author World evidence.

`world-host run APP --store STORE_DIR --run RUN_ID --branch main --json` creates a persisted run with a genesis branch head when needed, then advances one turn through `RunController` unless `--no-execute` is supplied. `world-host resume --store STORE_DIR --run RUN_ID --branch main --json` advances an existing branch one turn. These commands load installed WASM bytes from immutable store evidence, use disposable workers, submit boot/restore TurnInputs through the released wire codec, and let `RunController` persist the next TurnClosure and CAS the `RunHead`. They are bounded one-turn operations, not schedulers.

## Pinned World Surface

- World release: `v0.1.0`
- Boundary through World: `v0.6.2`
- Appliance ABI: `v4`
- TurnClosure format: `v1`
- Universal WASM SHA-256: `a79ae458d3cc5145660dadfc678736e75822c8c70558f8139861dc1103e84add`

The checksum is from the local World universal Appliance cache artifact selected by the real Carrier conformance proof and must be reverified against the published World v0.1.0 release before Carrier release.

## Proof

```sh
bun --version
bun run test
bun run proof
bun run proof:world-real
bun run proof:application-v1
bun run proof:application-v1-cli
bun run proof:frame-store
bun run build:agent-runtime-v1
bun run check:agent-runtime-v1
bun run conformance:agent-runtime-v1
bun run proof:agent
bun run proof:boundaries
bun scripts/build-agent-runtime-pack.mjs
bun scripts/check-agent-runtime-pack.mjs ./agent-runtime-v0.1
bun scripts/run-agent-runtime-conformance.mjs ./agent-runtime-v0.1
bun scripts/check-agent-runtime-release-receipt.mjs ./agent-runtime-v0.1
bun bin/world-host.mjs doctor --json
bun scripts/run-store-conformance.mjs
bun scripts/run-crash-matrix.mjs
bun scripts/run-migration-conformance.mjs
bun scripts/run-security-conformance.mjs
bun bin/world-host.mjs run-example file-rewrite-agent
bun bin/world-host.mjs run-example agent-skeleton
bun bin/world-host.mjs run-example agent-fixture
bun bin/world-host.mjs run-example agent-replay
bun bin/world-host.mjs run-example agent-migration
bun bin/world-host.mjs run-example crash-recovery
bun bin/world-host.mjs run-example migration
bun bin/world-host.mjs run-example branching
```

## Non-Claims

Carrier v0 does not claim exactly-once effects, distributed consensus, cryptographic authenticity, confidentiality, hostile-host protection, branch merging, remote transport, arbitrary shell execution, or new World semantics.
