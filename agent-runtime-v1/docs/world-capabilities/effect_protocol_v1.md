# Effect protocol v1

World Comptime applications expose only residual external effects. A capability
receives a World-authored `EffectRequest` and returns an untrusted
`EffectResult`. It never receives application state and cannot author a
`Frame`.

## Ownership

World owns request identity, interface and schema identity, effect-site
identity, allowed statuses, idempotency identity, and request limits.
world-host owns receiver policy, secrets, handler selection, journaling, and
attempt metadata. A capability owns only the concrete external operation and
its proposed outcome.

`CapabilityRouterV1` preserves that boundary in this order:

1. decode and authenticate the request;
2. select one explicit receiver binding by interface identity;
3. require exact payload schema, result schema, and authority identities;
4. project the request into the existing adapter-neutral request shape;
5. run adapter preflight before `resolve`;
6. reject any capability output that claims World or Boundary evidence;
7. validate the returned status against the request;
8. enforce the request-specific result-size and attempt limits;
9. encode only an identity-valid `EffectResult`.

`CapabilityRouterV1.inspect` decodes and checks the selected route without
calling adapter preflight or resolution. Pack declarations remain separately
inspectable as inert manifest data.

## Pack declarations

A pack that supports v1 includes `world-effect-v1` in
`supportedWorldProtocolVersions` and declares every supported interface in
`effectProtocolV1.interfaces`:

```json
{
  "applicationIds": [
    "88e5a053c2a16fe9093abe4aa9f0c34d3e56abc9d1080aff5eb346687e72be85"
  ],
  "authorityRequirements": "128",
  "interfaceId": "56b70f28567ba9275cb5533652d83fa7bc05c8e37c5b61c94c85763dbbf2de58",
  "interfaceLabel": "research.lookup.v1",
  "payloadSchemaId": "24eb8230d48242130660a1229ad28857eaad2d85315dfcee6d41f21badf3a03a",
  "resultSchemaId": "79828538ca9f2e3899120ce1ce96314bce094ab585c92b127d63f94ac8eb2172"
}
```

`applicationIds` is optional for reusable protocol packs. When present, the
router rejects a validly sealed request from every other application before
adapter preflight.

The pack verifier derives `interfaceId` from `interfaceLabel`, rejects duplicate
or malformed declarations, and includes the complete v1 declaration in the
pack fingerprint. A parity test compares each declaration with the live router
binding.

`inspectPack` validates declarations, checksums, and self-contained source
without importing adapter code. `verifyPack` adds executable adapter checks.

## Compatibility

The existing pack adapters remain the concrete effect implementations. The v1
router translates a validated `EffectRequest` into their neutral request shape
and translates the outcome into `EffectResult`. This reuse does not grant the
adapters authority to create Frames, receipts, checkpoints, or application
manifests.

## Proof

```bash
bun run proof:v1
```

The source-independent proof covers request and result identity, malformed
input, static inspection, policy-before-effect, evidence rejection, manifest
parity, replay result reuse, and exact pack/corpus receipt binding. The released
world-host lifecycle gate owns complete application execution, replay, retry,
branching, and migration.

The older checkout-coupled fixture integration remains available as
`bun run proof:v1-checkout-integration`; it is not part of the release gate.
