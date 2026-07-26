# Research Lookup Fixture

`research-lookup-fixture` implements only `research.lookup.v1` for the
Research Digest application in World `v1.0.0-rc.2`.

The pack is deterministic, bounded, network-free, secret-free, and
application-identity-bound. It accepts one typed request for at most two
research items and returns the exact fixture response recorded in
`corpus.json`.

The receiver must admit the package and set `policy.researchLookup=true`
before resolution. Static pack inspection reads declarations, checksums, and
source without importing `adapter.mjs`.

The pack never receives application state and cannot author Frames,
application manifests, World evidence, or Boundary evidence.
