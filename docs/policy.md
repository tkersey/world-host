# Capability Policy

`CapabilityPolicy` and `LiveRunPolicy` are receiver-local. Imported policy is not authority on another host, and migration re-preflights.

Defaults:

- live effects denied;
- network denied;
- file effects denied;
- human effects denied;
- best-effort denied;
- destructive writes require approval.

Policy gates authority labels, capability packs, origins, methods, file roots, byte limits, live model/tool budgets, redaction, dry-run, shadow, and audit-only operation.

Policy changes do not alter World semantic identity. They decide only what the receiver host may do locally.
