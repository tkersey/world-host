# World Application v1 Replay and Retry

`MemoryEffectJournalV1` and `DirectoryEffectJournalV1` persist an admitted
`EffectResult` block before the application receives it. Their records bind:

- run and branch;
- parent Frame id;
- request id and exact request artifact checksum;
- World idempotency key;
- effect interface;
- selected handler and handler-configuration identities;
- recovery class;
- result id and artifact reference.

The journal rejects a different result for the same branch-local request key. Reusing the same result returns the existing record.

If the host stops after result persistence, the next controller reads that result and submits it without invoking a capability again. If the host stops after child-Frame persistence but before head advancement, the same parent Frame, semantic EffectResult, and fuel reproduce the same child Frame bytes, which can then be published once.

These properties provide deterministic retry and replay suppression. They do not claim exactly-once external effects.

The directory-backed proof stops after result persistence, discards the active
controller, and resumes through a new `world-host app` process. The capability
outcome is not produced again, and the resulting Frame is byte-identical to a
fresh deterministic reduction of the same parent, result, and fuel.
