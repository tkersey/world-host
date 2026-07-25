# Hosting World Application WASM

`ApplicationWorker` runs an application-specific `*.world.wasm` module through World Application ABI v1.

Before instantiation, it requires:

- a valid WebAssembly module;
- zero imports;
- one wasm32, unshared linear memory with an explicit maximum;
- declared memory within the receiver limit;
- every required ABI export;
- ABI version 1;
- a canonical, identity-valid `ApplicationManifest` admitted by receiver limits.

One call accepts canonical `StepInput` bytes and returns canonical `Frame` bytes. The worker validates both records, checks application identity and parentage, and copies output before another mutating call. A fresh worker can continue from any admitted nonterminal Frame.

The worker retains no authoritative continuation. Disposal loses only compiled code and scratch memory.

## Current library surface

```js
import {
  ApplicationWorker,
  createEffectResult,
  encodeStepInput,
} from '../src/v1/index.mjs';
```

`RunControllerV1` adds immutable block retention, an effect-result journal, and
conditional branch-head advancement. `DirectoryApplicationStoreV1` retains
those records across process loss. The `world-host` command family installs
and drives arbitrary conforming application modules without interpreting
Boundary or World machine semantics.

Canonical initial arguments and EffectResults enter through files:

```sh
world-host inspect-app application.world.wasm
world-host install --store STORE --name APP --wasm application.world.wasm
world-host run --store STORE --app APP --run RUN --initial-args args.bin
world-host resume --store STORE --run RUN --effect-result result.bin
world-host inspect --store STORE --run RUN
world-host branch --store STORE --run RUN --branch alternate
world-host export --store STORE --run RUN --out migration.json
world-host import --store RECEIVER --in migration.json --run IMPORTED
```

The generic host does not translate application-specific text into typed
initial arguments. Applications or release packs supply those canonical bytes.
`inspect-app` parses bounded WASM metadata and the embedded manifest without
instantiating guest code. `retry` and `replay` reject fresh result and handler
options, reuse only a result already admitted to the effect journal, and
therefore do not call a capability. Diagnostics expose identities, statuses,
limits, and byte lengths only.

## Proof

```sh
bun test test/application_v1_protocol.test.mjs test/application_v1_storage.test.mjs test/application_v1_directory.test.mjs
bun run proof:application-v1
bun run proof:application-v1-cli
```

The real-artifact proofs retain the World one-effect application and add the
clean-room Research Digest application built from public release packages.
They prove zero imports, bounded memory, fresh-instance continuation,
byte-identical retry, result persistence before submission, Frame persistence
before head advancement, zero-fresh-effect replay, competing branches,
separate-process CLI continuation, and receiver-preflighted migration.
