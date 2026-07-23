# Agent Runtime v1 release-candidate pack

This pack contains three application-specific World WASM modules, the minimal
World Application Host v1 profile, receiver-side Effect protocol v1 handlers,
standalone conformance, documentation, and exact SHA-256 checksums.

It requires Bun but no Boundary, World, world-host, or world-capabilities source
checkout. It contains no Boundary Module, Executable.Image, TurnClosure, or
universal World runtime.

Release status: `release-candidate`.

```sh
bun conformance/check-pack.mjs
bun conformance/run.mjs
bun host/bin/world-host-v1.mjs help
```

Application and capability manifests declare requirements; they grant no
receiver authority. Configure policy, secrets, storage, and live capabilities
at the receiving host.
