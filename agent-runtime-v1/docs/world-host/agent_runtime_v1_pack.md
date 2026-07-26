# Agent Runtime v1 Pack

`agent-runtime-v1/` is the standalone distribution of the World Application
Host v1 profile. It contains application-specific World WASM, the generic v1
host, concrete capability packs, protocol documentation, checksums, and an
in-pack conformance runner. It contains no Boundary Module, Executable.Image,
universal World runtime, or v0 state translator.

Build the development pack from pinned local source artifacts:

```sh
bun scripts/build-agent-runtime-v1.mjs
```

The builder invokes World's three coordinated application-artifact build steps
and accepts the Research Digest WASM and manifest from the separate clean-room
release proof. It validates each embedded manifest, requires every application
to report the same Boundary StaticMachine and World Application ABI versions,
copies only the v1 host and released capability runtime surfaces, and writes a
complete `checksums.sha256` manifest. A release-candidate build fails unless
the Research Digest artifact is supplied outside all source repositories with
the exact reviewed WASM and manifest checksums. It also requires the
world-capabilities runtime release archive and verifies that archive's exact
checksum before copying any capability code. Each bundled capability records
its manifest checksum, and release packs require every checksum—not only the
clean-room fixture—to match the reviewed runtime distribution.

Check the distribution without loading capability adapters during static pack
inspection:

```sh
bun agent-runtime-v1/conformance/check-pack.mjs ./agent-runtime-v1
```

Run the lifecycle and negative scenarios using only files inside the pack:

```sh
bun scripts/run-agent-runtime-v1-conformance.mjs ./agent-runtime-v1
```

The same checks can be run after copying the directory away from the Boundary,
World, world-host, and world-capabilities source checkouts:

```sh
cd ./agent-runtime-v1
bun conformance/check-pack.mjs
bun conformance/run.mjs
```

The required scenarios retain the one-effect, skeleton, and file-rewrite
fixtures, then prove the clean-room Research Digest application with its custom
effect, compiled internal provider, separately released capability, fresh
instance continuation, one-invocation deterministic retry, zero-fresh-effect
replay, branching, migration, the operator CLI, and all required negative
cases.

The default builder emits `releaseStatus: development`. Changing that label is
not a release operation. A release-candidate or released pack additionally
requires reviewed and pinned Boundary, World, world-host, and capability
artifacts plus the cutover gates in `v0_v1_profiles.md`. Existing v0 runs remain
on Carrier v0; they are not translated into v1 Frames.

The checked-in pack is a release candidate with exact source commits, public
Boundary and World package identities, and checksum-bound world-capabilities
release assets. See
[`agent_runtime_v1_performance.md`](agent_runtime_v1_performance.md) for its
structural and environment-specific performance report.
