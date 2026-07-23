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
  "authorityRequirements": "2",
  "interfaceId": "68e03731654ae26c9f15d114362b1d87b513bb95e6d42c8d5debf5dd24f101fd",
  "interfaceLabel": "host.file.read.v1",
  "payloadSchemaId": "c0c747fa088e53a78edf901cf6d9fc7dfde00195e2ec58a16f891cb3aac95182",
  "resultSchemaId": "c0c747fa088e53a78edf901cf6d9fc7dfde00195e2ec58a16f891cb3aac95182"
}
```

The pack verifier derives `interfaceId` from `interfaceLabel`, rejects duplicate
or malformed declarations, and includes the complete v1 declaration in the
pack fingerprint. A parity test compares each declaration with the live router
binding.

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

The proof covers request and result identity, malformed input, static
inspection, policy-before-effect, evidence rejection, manifest parity, the
fixture agent's complete effect sequence, replay suppression, and deterministic
lost-output retry.
