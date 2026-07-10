# Observability

world-host emits an operational event stream and summary JSON. Events are diagnostics only and do not alter World evidence.

Event names include capability pack load, policy load, secret request/missing, HostRequest receipt, capability selection, preflight pass/reject, effect claim, dry-run/shadow/approval completion, resolution persistence, turn submission, closure receipt, branch advancement, replay/retry, migration import, run completion, and run failure.

Rules:

- JSONL output;
- summary JSON output;
- no secrets;
- prompts and responses redacted by policy;
- World fingerprints included where available;
- wall-clock time is diagnostics only;
- no OpenTelemetry dependency in v0.2.
