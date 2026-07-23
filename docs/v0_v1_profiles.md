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
operator path under `world-host app`. Directory records are namespaced below
`application-v1/`, and v1 commands never parse or mutate Carrier records. The
plain `world-host run`, `resume`, and related commands remain v0 until cutover;
the explicit `app` namespace prevents profile ambiguity during coexistence.
