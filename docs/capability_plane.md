# Capability Plane

Capabilities are host-side effect resolvers. Boundary defines what the agent wants. World validates and records what happened. world-host decides whether and how the local host may perform the effect.

Agent Capability Plane v0.2 keeps real integrations outside Boundary and World. A capability receives decoded World `HostRequest` data from world-host and may return untrusted `ResolutionInput` bytes. It must not author Boundary modules, World receipts, TurnClosures, Capsules, Chronicle events, Archive append batches, Actuation receipts, or Executable.Images.

The completion shape is:

```text
Agent Runtime v0.1 pack
  + capability pack
  + host policy
  + host secrets
  =
live-capable agent runtime
```

Boundary and World remain semantic core. world-host is the receiver-local capability membrane.

## Non-Claims

- no real integrations in Boundary;
- no real integrations in World;
- no vendor SDKs in world-host core;
- no credentials in World bytes;
- no exactly-once claim;
- no cryptographic trust claim;
- no package registry;
- no signing or encryption.

Fixture mode is the default proof path. Live mode is opt-in and rechecks receiver-local policy.
