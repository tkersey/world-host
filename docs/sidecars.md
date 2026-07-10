# Capability Sidecars

Sidecars let real integrations run outside the world-host process. v0.2 uses bounded stdin/stdout newline-delimited JSON frames. There is no network transport requirement.

Commands:

```text
manifest
preflight
resolve
recover
dry-run
shadow
```

Each command is one request and one response. Frames are bounded, timeouts are explicit, nonzero exits fail closed, and commands are argv arrays with `shell: false`. Request data is never interpolated into a shell command.

Sidecar output is untrusted. world-host validates every returned `ResolutionInput`; a sidecar cannot access World internals or mint World evidence. Logs are diagnostics only.
