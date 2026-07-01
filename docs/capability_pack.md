# Capability Pack

A `CapabilityPack` is a host-side distribution artifact. It contains a manifest, adapter or sidecar reference, conformance vectors, docs, non-claims, and artifact checksums. Checksums are artifact checksums, not signatures.

The manifest is versioned by:

```text
world_host_capability_pack_format_version = 1
world_host_capability_driver_abi_version = 1
```

Semantic identity is structural: descriptor fingerprint, ActuatorRef, actuation class, response statuses, recovery class, authority labels, byte limits, policy requirements, and secret descriptors. Display labels are diagnostics only. Operation-label dispatch is not authority.

No credentials or host-specific absolute filesystem paths belong in a pack. A pack may declare required secret names or classes; the receiver maps those descriptors to local providers.

Reference packs live under `capability-packs/` and are conformance fixtures, not production provider integrations.
