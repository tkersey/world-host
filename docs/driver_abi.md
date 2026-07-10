# Capability Driver ABI

The stable host-side ABI is over existing `HostRequest` and `ResolutionInput`:

```text
manifest() -> CapabilityManifest
assertRequestSupported(hostRequest) -> true | throws       # optional, synchronous, pure
preflight(context, hostRequest) -> CapabilityPreflightReport
resolve(context, hostRequest) -> ResolutionInput
recover(context, effectRecord) -> ResolutionInput | operator_required
dryRun(context, hostRequest) -> DryRunReport
shadow(context, hostRequest, recordedResolution) -> ShadowReport
```

Optional hooks are `assertRequestSupported(hostRequest)`, `cancel(context, effectRecord)`, and `query(context, externalTransactionRef)`. Request admission is a pure structural check: it must return `true` or throw synchronously, and must not perform I/O, read mutable external state, or consult receiver policy. The host applies it after manifest union coverage and before route selection, rebinding, or effect persistence. Driver `preflight()` remains the contextual async boundary for receiver-local policy and availability.

Drivers receive World HostRequest bytes decoded by world-host. Driver output is untrusted. World validates every resolution and constructs evidence. Drivers never mutate `RunHead`, bypass `EffectJournal`, receive raw secrets except through a `SecretProvider`, or mint World evidence.

Recovery classes are `pure`, `idempotent`, `externally_recoverable`, `transactional`, and `best_effort`. Durable automatic runs reject `best_effort` unless the operator explicitly opts in. The plane does not claim exactly-once effects.
