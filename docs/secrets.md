# Secrets

`SecretProvider` is a receiver-local membrane:

```text
describe(name) -> redacted descriptor
get(name, purpose) -> secret bytes/string
has(name) -> bool
```

Implemented providers are env, file, and prompt-for-local-tests. Cloud secret managers are not in v0.2 core; external capability packages may provide them later.

Secret values must never enter Boundary bytes, World bytes, TurnClosures, Archives, Actuation receipts, effect records, conformance receipts, or pack manifests. Diagnostics redact secret-shaped keys and values. Missing required secrets fail before live invocation.

Migration does not carry secrets. Receiver import reapplies local policy and local secret mapping.
