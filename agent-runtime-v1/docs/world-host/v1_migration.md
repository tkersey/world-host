# World Application v1 Migration

`RunControllerV1.exportBranch` produces a receiver-independent migration bundle containing:

- application WASM bytes;
- exact `ApplicationManifest` bytes;
- the selected current Frame bytes and identities;
- one retained pending `EffectResult`, when available;
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

This is v1-to-v1 migration. There is no TurnClosure-to-Frame or Capsule-to-Frame translation.

The operator transport is bounded JSON with canonical base64 fields:

```sh
world-host app export --store SOURCE --run RUN --out migration.json
world-host app import --store RECEIVER --in migration.json --run NEW_RUN
```

The JSON envelope is transport packaging, not application semantics. Import
rejects unknown fields, malformed or non-canonical base64, oversized embedded
records, manifest disagreement, and an existing target branch. Receiver
preflight occurs before the imported head becomes authoritative.
