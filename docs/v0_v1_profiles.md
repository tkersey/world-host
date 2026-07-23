# v0 and v1 Runtime Profiles

The two host profiles coexist without sharing semantic record kinds.

## Carrier v0

```text
universal World WASM
+ Executable.Image
+ TurnClosure
```

Carrier remains the compatibility path for existing v0 runs.

## Application Host v1

```text
application-specific World WASM
+ Frame
+ EffectResult
```

New v1 code lives under `src/v1/`. It does not import Carrier execution, TurnClosure, Executable.Image, Fabric, Runspace, or Boundary semantics.

There is no transparent state migration between profiles. Existing v0 runs complete under Carrier or restart at application-level inputs under v1. New functionality targets v1 after cutover; v0 remains correctness- and compatibility-only.

The v1 profile provides both in-memory proof stores and a directory-backed
operator path. Directory records are namespaced below `application-v1/`, and
v1 commands never parse or mutate Carrier records. After the compatibility
interval, both `world-host` and `world-host-v1` select this profile.
`world-host-legacy` is the only installed Carrier v0 entrypoint.

The v0 line is feature-frozen. Only correctness, compatibility, release, and
retirement changes may land there. Its proof and v0 Agent Runtime builder are
available only as `proof:legacy`, `build:agent-runtime-legacy`, and
`check:agent-runtime-legacy`. They are excluded from default proof and
distribution workflows.
