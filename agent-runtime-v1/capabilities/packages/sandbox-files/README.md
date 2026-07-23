# sandbox-files

Fixture-root local filesystem read/write skeleton. Default conformance uses only
temporary fixture paths.

`fixtureRoot` is receiver-owned authority and must not be concurrently writable
by an untrusted process. This fixture handler rejects path traversal and
pre-existing symlinks, but it is not an operating-system isolation boundary for
a hostile shared directory. Use a separately sandboxed, out-of-process
capability when that stronger threat model applies.
