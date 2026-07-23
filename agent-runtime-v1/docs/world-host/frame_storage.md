# Frame Storage v1

World Application v1 separates immutable bytes from the one mutable branch pointer.

Immutable blocks include:

- application WASM;
- `ApplicationManifest`;
- `Frame`;
- `EffectRequest`;
- `EffectResult`.

`MemoryBlockStore` and `DirectoryBlockStore` address exact bytes by SHA-256 and
return copies. The checksum is an integrity and content identifier, not a
signature or trust claim. On a repeated checksum, the store requires identical
bytes.

`MemoryBranchHeadStore` maps `(run_id, branch_id)` to:

```text
generation
application id
Frame id
Frame artifact reference
Frame status
```

`advanceHeadIfCurrent(expected, next)` advances only from the complete expected head. Genesis uses generation zero; each successful local advance increments generation by one. This prevents a stale writer from overwriting a winning child. It is not distributed consensus.

`DirectoryBranchHeadStore` implements the same contract with append-only
generation files. Each file binds the complete preceding head and the complete
next head. Competing writers attempt the same generation filename through an
atomic create, so one wins and the other observes the winner. Reads validate a
gap-free parent chain before returning the current head; no process-id lock is
part of the semantic path.

`RunControllerV1` publishes in this order:

1. validate application output;
2. retain the child Frame;
3. retain its pending EffectRequest, if any;
4. conditionally advance the branch head.

A CAS conflict leaves the valid child Frame retained as an explicit orphan. No partially encoded Frame becomes current.

All v1 mutable-profile records live below `application-v1/`; they do not share
v0 application, head, or effect-record formats.
