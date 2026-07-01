# world-host Agent Runtime Pack

This directory is the world-host carrier shipped inside Agent Runtime v0.1. It contains the pack-local CLI, runtime modules, examples, and release verification scripts.

From this directory, run the complete pack verification command:

```sh
bun run check:agent-runtime
```

From the pack root, the direct verification steps are:

```sh
bun world-host/scripts/check-agent-runtime-pack.mjs .
bun world-host/scripts/run-agent-runtime-conformance.mjs .
bun world-host/scripts/check-agent-runtime-pack.mjs . --require-release-receipt
bun world-host/scripts/check-agent-runtime-release-receipt.mjs .
```

Install the carrier from the pack with:

```sh
bun world-host/bin/world-host.mjs agent install --pack . --store <store>
```
