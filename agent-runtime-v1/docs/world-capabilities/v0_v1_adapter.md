# v0 and v1 adapter boundary

Concrete capability implementations are shared where their external operation
is unchanged. Protocol authority is not shared.

```text
v0 HostRequest ─┐
                ├─> neutral adapter request -> capability outcome
v1 EffectRequest┘

capability outcome -> v0 ResolutionInput
capability outcome -> v1 EffectResult
```

For v1, `CapabilityRouterV1` owns both projections. It validates the
World-authored request before constructing the neutral adapter request, then
validates the capability outcome before constructing `EffectResult`.

The stable compatibility surface is limited to:

- `EffectRequest` and `EffectResult`;
- the capability manifest;
- receiver-local policy;
- the secret provider;
- the effect journal.

The v0 Capability Plane's internal classes and file layout are not part of the
v1 contract. `capability-driver-v0` remains the concrete adapter ABI during the
compatibility interval; declaring `world-effect-v1` means that the pack has an
explicit, fingerprint-bound v1 router mapping. It does not mean the adapter may
decode World Frames or author World evidence.

After v1 cutover, new capability behavior targets the v1 effect boundary.
Correctness and compatibility fixes may continue on v0, but v0 does not remain
a co-equal feature surface.
