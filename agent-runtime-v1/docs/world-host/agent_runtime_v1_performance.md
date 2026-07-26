# Agent Runtime v1 Performance Report

This report records the World Comptime v1.0.0 released-pack measurements. The
architecture is accepted on structural grounds first: application-specific
WASM, zero imports, fixed memory, no runtime image loader, no source checkout,
and explicit portable Frames. Wall-clock measurements are observations, not
portable acceptance thresholds.

## Measurement environment

```text
Bun:          1.3.14
Platform:     darwin arm64
Processor:    Apple M2 Pro
Cold samples: 10
Warm samples: 25
```

The reported compile measurement used the existing Zig cache. It measures the
three-owner-target incremental build, not a clean toolchain bootstrap.

```text
Incremental application build: 288.6 ms
```

## Application measurements

| Application | WASM bytes | Fixed memory | First Frame | First state | Cold instantiate median | First step median | Warm step median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one-effect | 106,535 | 8 MiB | 771 B | 336 B | 1.119 ms | 1.419 ms | 0.110 ms |
| skeleton-agent | 143,256 | 16 MiB | 809 B | 370 B | 1.184 ms | 1.419 ms | 0.112 ms |
| fixture-agent | 190,381 | 16 MiB | 816 B | 376 B | 1.409 ms | 1.404 ms | 0.113 ms |
| research-digest-agent | 171,289 | 32 MiB | 1,425 B | 963 B | 1.316 ms | 1.836 ms | 0.140 ms |

`First step` runs genesis to the first external effect boundary. `Warm step`
reuses one instantiated worker only as a cache; each call still begins from
explicit input bytes, and no live worker state is authoritative.

## Structural comparison with Carrier v0

The v1 pack requires only each application WASM and its host state. It contains
no universal World WASM, `Executable.Image`, Boundary Module, runtime linker,
Fabric-plan loader, or source checkout. The application artifacts are
106–190 KiB with 8–32 MiB fixed memories. The retained Carrier v0 universal
WASM uses 64 MiB linear memory and additionally requires an
`Executable.Image`.

No percentage speedup is claimed. The released v1.0.0 pack satisfies the
intended cutover criterion through smaller deployment authority and fewer
runtime boundaries; future optimization must preserve the same Frame and
effect semantics.

Reproduce the local measurement:

```sh
bun run measure:agent-runtime-v1
```
