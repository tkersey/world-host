# Live Smoke

The optional live smoke harness is:

```sh
WORLD_HOST_LIVE_SMOKE=1 bun scripts/run-live-capability-smoke.mjs --config live.local.json --secret-provider env --allow-origin https://example.invalid
```

It is skipped unless `WORLD_HOST_LIVE_SMOKE=1` is set. It requires an explicit config path, secret provider, and allowlist. It defaults to dry-run unless `--live` is supplied. Live unsafe HTTP methods and configs marked `destructive` require `--allow-destructive`.

No credentials, endpoint, or provider defaults are committed to the repo. Diagnostics are redacted.
