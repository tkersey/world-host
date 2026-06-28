# Agent Runtime v0.1 RC

Agent Runtime packages a Boundary agent program, World executable/deployment
evidence, and world-host carrier operation into one inspectable directory.

```text
Agent Runtime distribution
  =
Boundary agent program
  + World executable/deployment evidence
  + world-host carrier operation
  + conformance proof
```

The agent is a Boundary program. World turns it into a portable executable
process. world-host operates that process by resolving effects and retaining
World-authored evidence.

## Commands

```sh
bun scripts/build-agent-runtime-pack.mjs
bun scripts/check-agent-runtime-pack.mjs ./agent-runtime-v0.1
bun scripts/run-agent-runtime-conformance.mjs ./agent-runtime-v0.1
bun scripts/emit-agent-runtime-release-receipt.mjs ./agent-runtime-v0.1
bun scripts/check-agent-runtime-release-receipt.mjs ./agent-runtime-v0.1
```

`world-host agent install --pack agent-runtime-v0.1 --store STORE --app APP`
installs the distributed WASM, image, and manifest into a local store. The
`agent run`, `agent resume`, `agent inspect`, `agent replay`, `agent migrate`,
`agent import`, and `agent conformance` wrappers stay one-shot and delegate to
the existing Carrier commands.

## Current Owner-Export Status

The pack builder requires owner-exported Boundary agent/root toolbox bytes and
World Agent Runtime executable image/appliance manifest bytes. Pack checks fail
if those exports are missing or if the conformance corpus records owner-export
warnings.
