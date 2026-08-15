# Contributing

world-host requires Bun 1.3.2 or newer. Run:

```sh
bun test --timeout 30000
bun run proof:v1-tests
bun run check:public-runtime-v1
bun run conformance:public-runtime-v1
```

Do not commit credentials, authorization headers, private endpoints, personal
data, live provider payloads, runtime stores, or owner-local paths. Test data
must be synthetic, bounded, deterministic, and safe to publish.

world-host stores and transports World-authored Frames. It does not give
capabilities authority to author Frames, Machine state, or application
results. Capability handlers remain receiver-local and execute only after
receiver policy admits the exact request.

Pull requests from forks run without repository or environment secrets.
Live-provider and mutation proofs never run for untrusted pull requests.
Keep runtime protocol changes separate from documentation, packaging, and
release-readiness work.
