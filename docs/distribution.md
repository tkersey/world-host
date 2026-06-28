# Distribution Notes

`world-host-v0` consists of:

- Carrier core modules under `src/core`;
- Bun CLI and worker adapter under `src/bun`;
- MemoryStore and DirectoryStore under `src/stores`;
- reference drivers under `src/drivers`;
- protocol manifest, dependency-free World JS codecs, and TurnClosure inspection helpers under `src/protocol`;
- deterministic examples under `examples`;
- conformance scripts under `scripts`;
- security and migration documentation under `docs`.

Runtime third-party dependencies: zero.

Pinned versions:

- World: `v0.1.0`
- Boundary through World: `v0.5.0`
- Appliance ABI: `v3`
- TurnClosure format: `v1`
- universal WASM SHA-256: `938dfe12937b5ca767793bbbc5e8d2e2122caf7134efe52fba7fb7892930c589`

The real-World proof lane is:

```sh
bun scripts/run-world-conformance.mjs --world-repo ../world
```

That lane requires prebuilt World universal Appliance artifacts and fails closed if no compatible WASM/image fixture pair is found. It includes a store-backed `RunController` boot proof for a no-host fixture image: `MemoryStore` stores the actual image and Appliance manifest bytes, `RunController` submits one boot turn, and the resulting head is verified against the real worker's TurnClosure bytes.

The same lane also includes a terminal-head proof: after a no-host boot completes, the boot worker is disposed and a fresh controller rejects the completed branch head before creating another worker. Needs-host continuation remains the restore/continue proof: Carrier binds the exact parent closure evidence, persists the host response through `EffectJournal`, and submits the released wire-codec continuation only while the head is continuable.

The real lane also covers one journaled HostRequest continue for fixture image A. `RunController` inspects the committed needs-host TurnClosure, maps the pending World HostRequest into an effect-journal request with complete idempotency key bytes and exact request bytes, resolves it through exact driver coverage, persists the deterministic driver's untrusted ResolutionInput before World submission, reuses that persisted outcome on a lost-output retry without a second driver invocation, and commits the completed World-authored TurnClosure. This is not an exactly-once claim.

For batched host effects, `RunController` resolves every covered pending HostRequest before submitting a continue turn, groups work by exact driver and recovery class, and limits each group by the smaller of the driver's `concurrencyLimit` and local `maximumConcurrentEffects` policy. ResolutionInputs are persisted independently through `EffectJournal`; the released wire codec owns canonical TurnInput ordering.

Missing exact driver coverage is a hard failure by default. A receiver-local `allowPartialEffectBatch` policy may submit a partial batch containing only covered persisted ResolutionInputs; uncovered HostRequests are reported as host diagnostics and receive no fabricated effect record, receipt, or ResolutionInput.

For the crash window after `RunHead` CAS and before effect finalization, recovery uses the committed head's `parentTurnClosureFingerprint` diagnostic to mark only same-run, same-branch `submitted` effects as `closure_committed`. This is reconciliation of host operational state after the head is authoritative, not a driver retry or a World receipt.

Operator inspection commands can read persisted `DirectoryStore` evidence:

```sh
bun bin/world-host.mjs inspect --store STORE_DIR --run RUN_ID --branch BRANCH_ID --json
bun bin/world-host.mjs effects --store STORE_DIR --run RUN_ID --json
bun bin/world-host.mjs recover --store STORE_DIR --run RUN_ID --branch BRANCH_ID --json
bun bin/world-host.mjs install --store STORE_DIR --name APP --wasm world_universal_appliance.wasm --image app.world-executable --image-fingerprint WORLD_FINGERPRINT --json
bun bin/world-host.mjs run APP --store STORE_DIR --run RUN_ID --branch BRANCH_ID --json
bun bin/world-host.mjs resume --store STORE_DIR --run RUN_ID --branch BRANCH_ID --json
bun bin/world-host.mjs fork --store STORE_DIR --run RUN_ID --from CLOSURE --branch NEW_BRANCH --source-branch BRANCH_ID --json
bun bin/world-host.mjs export --store STORE_DIR --run RUN_ID --branch BRANCH_ID --out PACKAGE.json --json
bun bin/world-host.mjs import --store RECEIVER_DIR --package PACKAGE.json --run RECEIVER_RUN_ID --json
```

These commands acquire the local store lock, read run/head/effect records, summarize operational diagnostics, redact secret-shaped fields, and release the lock. They do not execute workers, invoke drivers, mutate run heads, author World evidence, or print complete idempotency key bytes.

`install --store` is the application installation command. It writes the supplied universal WASM and Executable.Image bytes through immutable blob storage, requires the operator to provide the Executable.Image World fingerprint with `--image-fingerprint`, records the universal WASM field as a host SHA-256 checksum, and creates an `ApplicationRecord`. If `--manifest` is absent, Carrier stores a host-generated install-summary blob marked as diagnostics and `worldAuthoredEvidence: false`; that blob is not a replacement for World-authored Appliance evidence.

`run --store` creates a persisted run with a genesis branch head when the named run id is absent, optionally stores `--input` bytes as host creation metadata, and advances one turn through `RunController` unless `--no-execute` is supplied. `resume --store` advances an existing run branch one turn. Both commands resolve installed WASM bytes from immutable store data, construct disposable workers, provide boot or restore TurnInputs through the released wire codec, and leave TurnClosure persistence and RunHead CAS to `RunController`. They do not create a background scheduler or directly author World semantic evidence.

`recover --store` additionally runs the `DirectoryStore` recovery scanner and reports ignored temporary files, orphan blobs, no garbage collection, and no multi-process writer support. When a run and branch are supplied, it reconciles only matching `submitted` effects from the committed head's parent TurnClosure fingerprint to `closure_committed`; this is host operational reconciliation after `RunHead` is already authoritative, not a driver retry, receipt fabrication, lock override, garbage collection pass, or semantic World validation.

`fork --store` creates a new branch head at the selected stored closure and leaves the source branch unchanged. `export --store` writes a local `CarrierExport-v0` package with release identity, selected run/branch, exact immutable blob bytes, and `authorityCarried: false`. `import --store` reads that package, re-applies receiver-local preflight, writes immutable blobs through checksum verification, creates a receiver-local run id, and reports `authorityImported: false`. Transport remains outside v0.

The flagship file rewrite command:

```sh
bun bin/world-host.mjs run-example file-rewrite-agent
```

uses a temporary `DirectoryStore` rather than an in-memory fixture. It persists application, run, branch head, closure-like, archive-append fixture, and effect records; executes real `SandboxFileDriver` read/write requests through `EffectJournal`; proves retry of the write request reuses the persisted ResolutionInput; and reopens the store to inspect completion without invoking any driver. The command intentionally reports `hostFixtureOnly: true`; World-authored TurnReceipt, root-result, and Archive semantic evidence are still supplied by the real World conformance script.
