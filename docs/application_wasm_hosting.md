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
those records across process loss. The `world-host app` command family installs
and drives arbitrary conforming application modules without interpreting
Boundary or World machine semantics.

Canonical initial arguments and EffectResults enter through files:

```sh
world-host app install --store STORE --name APP --wasm application.world.wasm
world-host app run --store STORE --app APP --run RUN --initial-args args.bin
world-host app resume --store STORE --run RUN --effect-result result.bin
world-host app inspect --store STORE --run RUN
```

The generic host does not translate application-specific text into typed
initial arguments. Applications or release packs supply those canonical bytes.

## Proof

```sh
bun test test/application_v1_protocol.test.mjs test/application_v1_storage.test.mjs test/application_v1_directory.test.mjs
bun run proof:application-v1
bun run proof:application-v1-cli
```

The real-artifact proofs use the sibling World one-effect application. They
prove zero imports, bounded memory, fresh-instance continuation, byte-identical
retry, result persistence before submission, Frame persistence before head
advancement, competing branches, separate-process CLI continuation, and
receiver-preflighted migration.
