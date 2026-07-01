# Capability Driver ABI

The stable host-side ABI is over existing `HostRequest` and `ResolutionInput`:

```text
manifest() -> CapabilityManifest
preflight(context, hostRequest) -> CapabilityPreflightReport
resolve(context, hostRequest) -> ResolutionInput
recover(context, effectRecord) -> ResolutionInput | operator_required
dryRun(context, hostRequest) -> DryRunReport
shadow(context, hostRequest, recordedResolution) -> ShadowReport
```

Optional hooks are `cancel(context, effectRecord)` and `query(context, externalTransactionRef)`.

Drivers receive World HostRequest bytes decoded by world-host. Driver output is untrusted. World validates every resolution and constructs evidence. Drivers never mutate `RunHead`, bypass `EffectJournal`, receive raw secrets except through a `SecretProvider`, or mint World evidence.

Recovery classes are `pure`, `idempotent`, `externally_recoverable`, `transactional`, and `best_effort`. Durable automatic runs reject `best_effort` unless the operator explicitly opts in. The plane does not claim exactly-once effects.
