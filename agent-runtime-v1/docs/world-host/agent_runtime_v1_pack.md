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

The builder first invokes World's three application-artifact build steps. It
then validates each embedded application manifest, requires all applications to
report the same Boundary StaticMachine and World Application ABI versions,
copies only the v1 host and capability surfaces, and writes a complete
`checksums.sha256` manifest. It never certifies a previously installed WASM
without rerunning its owner build step.

Check the distribution without loading capability adapters during static pack
inspection:

```sh
bun scripts/check-agent-runtime-v1-pack.mjs ./agent-runtime-v1
```

Run the six behavioral scenarios using only files inside the pack:

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

The required scenarios are one external effect, the skeleton agent, the
fixture file-rewrite agent, an internal provider parked on an external effect,
deterministic retry, and branching. The fixture proof also replays retained
results with zero fresh effects and verifies the exact output and final result.

The default builder emits `releaseStatus: development`. Changing that label is
not a release operation. A release-candidate or released pack additionally
requires reviewed and pinned Boundary, World, world-host, and capability
artifacts plus the cutover gates in `v0_v1_profiles.md`. Existing v0 runs remain
on Carrier v0; they are not translated into v1 Frames.
