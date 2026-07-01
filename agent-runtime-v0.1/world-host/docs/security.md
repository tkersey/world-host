# Security Model

Carrier treats Executable.Image bytes, TurnClosure bytes, host requests, ResolutionInput bytes, migrated bundles, store contents, file paths, HTTP responses, and diagnostics as untrusted.

The implemented v0 host protections are:

- immutable SHA-256 blob addressing as storage checksum only, not trust;
- receiver-local capability preflight;
- exact driver manifest routing by ActuatorRef, descriptor fingerprint, actuation class, and response status;
- sandbox file path escape and symlink rejection;
- HTTP origin and method allowlists;
- credential redaction in CLI-shaped diagnostics;
- no runtime dependencies, shell driver, helper process, or child-process protocol encoding.

Explicit non-claims: no exactly-once effects, signing, encryption, distributed consensus, hostile-host protection, multi-writer durability, or malicious-runtime protection.
