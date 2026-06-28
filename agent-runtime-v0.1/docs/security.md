# Security

Trusted: selected Boundary release, selected World release, selected world-host package, receiver-local policy, receiver-owned drivers.

Untrusted: model outputs, file paths from agent, host claim bytes, migrated packages, stored blobs, TurnClosure bytes from outside the store, Executable.Image bytes from outside the release pack.

Non-claims: no cryptographic authenticity, confidentiality, exactly-once effects, distributed consensus, hostile-host protection, malicious-runtime protection, production durability guarantee, arbitrary shell authority, or real model trust guarantee.

FixtureModelDriver is deterministic test-only. SandboxFileDriver must reject path and symlink escape. No shell driver or real model driver is included in v0.1.
