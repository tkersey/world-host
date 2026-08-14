# world-host

world-host is the public reference host for application-specific World WASM
and portable Frames.

World Application Host v1 runs application-specific World WASM. It treats:

```text
application WASM + authoritative Frame + persisted EffectResults
```

as the complete recoverable process. A warm JavaScript object, WASM instance,
file descriptor, process id, request token, allocator, or worker assignment is
never authoritative.

This repository owns host concerns only: storing World-authored bytes, choosing
the active branch head, recording external outcomes, running disposable WASM
workers, recovery, migration, and operator tooling. Boundary and World
execution semantics stay inside the application artifact.

## Current Surface

World Application Host v1 is present as a disjoint profile under `src/v1/`. It
admits application-specific, import-free World WASM; validates canonical
ApplicationManifest, StepInput, EffectRequest, EffectResult, and Frame bytes;
continues on disposable workers; persists EffectResults before submission;
retains child Frames before conditional head advancement; and proves retry,
migration, replay, and branching against both the real World one-effect
artifact and a clean-room Research Digest application. Both
in-memory and directory-backed stores are implemented. The `world-host` CLI
inspects artifacts; installs, runs, resumes, retries, replays, and inspects
runs; branches lineages; and exports, imports, and lists v1 applications.

`bun run build:agent-runtime-v1` assembles the standalone development pack from
the current World application artifacts, v1 host, and v1 capability protocol.
`bun run check:agent-runtime-v1` validates its checksums, manifests,
zero-import/bounded-memory WASMs, and static capability declarations without
executing adapters. `bun run conformance:agent-runtime-v1` runs the complete
Research Digest lifecycle and the retained coordinated fixtures using only
files inside the pack. See
[`docs/agent_runtime_v1_pack.md`](docs/agent_runtime_v1_pack.md) and the
[`release-candidate performance report`](docs/agent_runtime_v1_performance.md).

Both `world-host` and `world-host-v1` run application-specific v1 artifacts.
Existing Carrier v0 runs remain available through `world-host-legacy`; it is a
legacy compatibility profile and accepts correctness and compatibility changes
only.

## Public runtime distribution

world-host v1.0.1 publishes a source-independent runtime at:

```text
https://github.com/tkersey/world-host/releases/download/v1.0.1/world-host-v1.0.1-runtime.tar.gz
https://github.com/tkersey/world-host/releases/download/v1.0.1/world-host-v1.0.1-runtime.tar.gz.sha256
```

Build and verify the exact release shape locally:

```sh
bun run build:public-runtime-v1
bun scripts/check-public-runtime-v1.mjs \
  --archive zig-out/public-runtime/world-host-v1.0.1-runtime.tar.gz \
  --checksum zig-out/public-runtime/world-host-v1.0.1-runtime.tar.gz.sha256
bun scripts/run-public-runtime-v1-conformance.mjs \
  --archive zig-out/public-runtime/world-host-v1.0.1-runtime.tar.gz \
  --checksum zig-out/public-runtime/world-host-v1.0.1-runtime.tar.gz.sha256 \
  --fixture-pack agent-runtime-v1
```

The archive contains only the v1 host runtime, operator entry points, its
manifest, license, and source-independent verification code. It contains no
application, capability pack, runtime store, secret, or source-checkout
dependency. The verifier rejects escaping paths, links, duplicate entries,
unexpected roots, missing licenses, missing entry points, incomplete checksum
coverage, and oversized expansion.

The deterministic public proof requires no GitHub authentication or receiver
credential. Live capabilities remain explicit receiver-operated integrations
and are not part of the default check.

This repository is a reference implementation. Application ABI v1 permits
alternate hosts. It does not claim exactly-once effects or protection from a
hostile host.

## Five-minute external application run

No Boundary, World, world-host, or world-capabilities source checkout is needed
after the release pack has been assembled:

```sh
world-host inspect-app research-digest-agent.world.wasm
world-host install \
  --store STORE \
  --name research-digest-agent \
  --wasm research-digest-agent.world.wasm
world-host run \
  --store STORE \
  --app research-digest-agent \
  --run run-1 \
  --initial-args input.bin
world-host resume \
  --store STORE \
  --run run-1 \
  --effect-result research-result.bin
world-host inspect --store STORE --run run-1
```

`world-host inspect-app` reports application, ABI, residual-effect, authority,
memory, and zero-import metadata through a disposable isolated worker with a
bounded deadline; guest initialization cannot stall the operator process.
`world-host retry` and `world-host replay` accept no fresh EffectResult or
handler metadata; they continue only from a result already retained by the
store. `world-host branch` aliases `fork`; and `export`/`import` move the
application, current Frame, and retained result to a fresh store.

`world-host install --store STORE --name APP --wasm application.world.wasm`
validates the zero-import ABI and records the WASM and embedded manifest as
immutable blocks. `world-host run --store STORE --app APP --run RUN
--initial-args args.bin` creates a Frame lineage. `world-host resume
--store STORE --run RUN --effect-result result.bin` persists the result before
submitting it to a fresh worker. The CLI reports identities, statuses, counters,
and byte lengths; it does not print application state, payload, result, or
secret bytes.

## Legacy Carrier v0

The retained legacy profile contains the Carrier v0 host boundary: immutable
blob stores, mutable branch heads, effect journal recovery classes, disposable
worker/controller contracts, receiver-local capability preflight, constrained
reference drivers, migration/fork helpers, redacted CLI diagnostics,
dependency-free World JS codecs, and the universal Appliance worker. It is not
part of the default proof or new-application path.

`bun scripts/run-world-conformance.mjs --world-repo ../world` executes real World universal Appliance fixture images through Carrier's `BunWorldWorker` and protocol codecs. It also boots a no-host fixture through `RunController` and `MemoryStore`, verifies that the committed branch head points at the same immutable TurnClosure bytes returned by the real worker, then proves a completed head is rejected before a fresh worker is created. The same lane boots a needs-host fixture and lets `RunController` inspect the parent TurnClosure, resolve the real HostRequest through `EffectJournal`, persist the untrusted ResolutionInput before World submission, reuse that persisted outcome on a lost-output retry without invoking the deterministic driver again, and commit the completed TurnClosure. For closures with multiple pending HostRequests, the controller groups requests by exact driver and recovery class, enforces bounded driver concurrency, persists each outcome independently, and constructs one continue TurnInput through the released wire codec so host completion order is not authoritative. Missing driver coverage remains fail-closed by default; a receiver-local `allowPartialEffectBatch` policy may submit only covered persisted outcomes and record unresolved request diagnostics. The deterministic examples still prove Carrier host behavior around stores, effects, migration, and branching; the real World fixture lane is the proof that the worker/codecs/controller can produce, continue from persisted host outcomes, reject terminal heads, and commit World-authored TurnClosure bytes, root result bytes, and Archive append evidence without a native helper process.

`bun bin/world-host.mjs run-example file-rewrite-agent` is a durable host-level flagship fixture. It creates a temporary `DirectoryStore`, installs application/run/head records and immutable blobs, resolves real sandbox file read/write requests through `EffectJournal`, retries the write by the same full World idempotency key without invoking the file driver again, commits the final host branch head, then reopens the store and inspects the completed run, effects, output file, closure blob, and retained archive-append fixture bytes without executing a driver. It is explicit host evidence only; World semantic TurnReceipt/root-result validation remains in the real World conformance lane above.

`bun run proof:legacy-agent` runs the Agent Closure host proof. It first
validates the sibling World `dist-world-agent-v0` gate, then exercises
Carrier-side skeleton, fixture file rewrite, replay, retry, migration,
branching, and negative lanes.

`bun run build:agent-runtime-legacy` creates the retained `agent-runtime-v0.1/`
pack. `bun run check:agent-runtime-legacy` verifies its checksums and legacy
conformance.

`RunController` can advance a branch from real worker output by inspecting World-authored TurnClosure bytes for the next `RunHead` fingerprints. That inspection is host metadata extraction only; Carrier does not validate or author World receipts, capsules, archive moments, chronicle events, or TurnClosures.

If a host dies after advancing `RunHead` but before finalizing effect records, `EffectJournal` can reconcile `submitted` records from the committed head's parent TurnClosure fingerprint. This recovery only marks matching run/branch effects `closure_committed`; it does not rerun drivers or create World evidence.

`world-host-legacy inspect --store STORE_DIR --run RUN_ID --branch BRANCH_ID
--json` and `world-host-legacy effects --store STORE_DIR --run RUN_ID --json`
read persisted Carrier records without entering the v1 profile.

`world-host-legacy recover --store STORE_DIR --json` retains the Carrier
recovery scanner and effect reconciliation path.

`world-host-legacy fork`, `export`, and `import` retain the Carrier branching and
migration operations.

`world-host-legacy install` retains universal-WASM plus `Executable.Image`
installation for existing Carrier applications.

`world-host-legacy run` and `resume` continue existing Carrier runs. They are
bounded one-turn operations, not schedulers.

## Legacy pinned World surface

- World release: `v0.1.0`
- Boundary through World: `v0.6.2`
- Appliance ABI: `v4`
- TurnClosure format: `v1`
- Universal WASM SHA-256: `a79ae458d3cc5145660dadfc678736e75822c8c70558f8139861dc1103e84add`

The checksum is from the local World universal Appliance cache artifact selected by the real Carrier conformance proof and must be reverified against the published World v0.1.0 release before Carrier release.

## Proof

```sh
bun --version
bun run proof
bun run proof:application-v1
bun run proof:application-v1-cli
bun run proof:frame-store
bun run build:agent-runtime-v1
bun run check:agent-runtime-v1
bun run conformance:agent-runtime-v1
bun run measure:agent-runtime-v1
```

### Legacy proof

```sh
bun run proof:legacy
bun run proof:legacy-world-real
bun run proof:legacy-agent
bun run proof:legacy-boundaries
bun run build:agent-runtime-legacy
bun run check:agent-runtime-legacy
```

## Non-Claims

World Application Host v1 does not claim exactly-once effects, distributed
consensus, cryptographic authenticity, confidentiality, hostile-host
protection, branch merging, remote transport, or arbitrary shell execution.
