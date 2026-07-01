# Capability Runtime Examples

These examples exercise Capability Plane v0.2 without external network access by default.

- fixture baseline: deterministic model capability returns fixture `ResolutionInput`.
- dry-run model: generic HTTP JSON capability reports the proposed request without invoking the endpoint.
- approval-gated file rewrite: human approval fixture gates a sandbox file write.
- shadow model: fixture resolution remains authoritative while shadow output is diagnostics only.
- denied live run: missing live policy fails closed.
- sidecar capability: covered by `bun run proof:sidecars`.

Run through the CLI with:

```sh
bun bin/world-host.mjs run-example capability-runtime
```
