# World Application v1 Migration

`RunControllerV1.exportBranch` produces a receiver-independent migration bundle containing:

- application WASM bytes;
- exact `ApplicationManifest` bytes;
- the selected current Frame bytes and identities;
- one retained pending `EffectResult` and its exact retry fuel, when available;
- source-head generation as provenance.

The bundle carries no receiver policy, secret, credential, storage path, or live worker state.

`RunControllerV1.importBranch`:

1. instantiates and validates the application artifact;
2. runs receiver-local manifest preflight;
3. requires exact exported and embedded manifest bytes;
4. validates and retains the Frame;
5. validates and retains an included EffectResult;
6. creates a receiver-local generation-zero head last.

The receiver can then continue with a fresh worker and the retained result.

The Research Digest conformance lane exports while the application is parked
on `research.lookup.v1` after the capability result has been persisted but
before the child Frame is published. A fresh receiver re-runs capability
coverage preflight, imports the WASM, manifest, parent Frame, and retained
result, then completes without a new capability call.

This is v1-to-v1 migration. There is no TurnClosure-to-Frame or Capsule-to-Frame translation.

The operator transport is bounded JSON with canonical base64 fields:

```sh
world-host export --store SOURCE --run RUN --out migration.json
world-host import --store RECEIVER --in migration.json --run NEW_RUN
```

The JSON envelope is transport packaging, not application semantics. Import
accepts an early v1 envelope without `retainedEffectFuel` only when no retained
result requires retry fuel. It rejects unknown fields, malformed or
non-canonical base64, oversized embedded records, a retained result without
fuel, manifest disagreement, and an existing target branch. Receiver preflight
occurs before the imported head becomes authoritative.

Export also fails closed when an early release-candidate journal record retains
a result without fuel. Retry that branch with the original explicit fuel before
exporting it; the host does not emit a migration bundle that import must reject.
