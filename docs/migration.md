# Migration

Carrier migration packages carry immutable host-stored bytes and operational metadata. They do not carry filesystem, network, model, human, or credential authority.

`DirectoryStore.exportRun` serializes the exact immutable blob bytes referenced by the selected store into the package. `DirectoryStore.importRun` writes those bytes through the immutable blob path, recomputes SHA-256, and rejects checksum mismatches. SHA-256 remains a host-storage checksum only; World fingerprints remain separate evidence fields.

Receiver import:

1. checks the CarrierExport shape;
2. rejects unrecoverable running best-effort effects;
3. runs an optional receiver-local preflight hook;
4. rewrites the run id to a receiver-local id;
5. imports immutable blobs, head, run, and relevant effect records through the store contract.

Branching is explicit. `forkRunBranch` creates a new branch head at the selected source closure and does not mutate the source branch. v0 has no branch merge semantics.

The Node CLI exposes local file migration and branching over `DirectoryStore`:

```sh
node bin/world-host.mjs fork --store STORE_DIR --run RUN_ID --from CLOSURE --branch NEW_BRANCH --source-branch main --json
node bin/world-host.mjs export --store STORE_DIR --run RUN_ID --branch main --out carrier-export.json --json
node bin/world-host.mjs import --store RECEIVER_DIR --package carrier-export.json --run RECEIVER_RUN_ID --json
```

These commands acquire the local store lock, emit redacted operational JSON, and do not execute workers, invoke drivers, transfer credentials, grant receiver authority, print complete idempotency key bytes, fabricate World evidence, or merge branches.

The released World JS codecs remain a prerequisite for semantic validation of migrated World-authored bytes.
