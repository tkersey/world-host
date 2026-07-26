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
- exact retry fuel;
- result id and artifact reference.

The journal rejects a different result or fuel budget for the same branch-local
request key. Reusing the same result and fuel returns the existing record. A
fork of a parked branch copies an already retained result, metadata, and fuel
into a candidate journal namespace before publishing the target head. The
winning head binds that namespace, so a losing concurrent fork cannot expose
its copied result through the winning branch.

If the host stops after result persistence, the next controller reads that result and submits it without invoking a capability again. If the host stops after child-Frame persistence but before head advancement, the same parent Frame, semantic EffectResult, and fuel reproduce the same child Frame bytes, which can then be published once.

These properties provide deterministic retry and replay suppression. They do not claim exactly-once external effects.

Early release-candidate journal records did not retain fuel. The v1 reader
accepts those records without inventing a budget. `retry` and `replay` require
an explicit `--fuel` for such a record; the operator must supply the budget used
for the interrupted step. New records retain fuel and reuse it automatically.

The directory-backed proof stops after result persistence, discards the active
controller, and resumes through a new `world-host` process. The capability
outcome is not produced again, and the resulting Frame is byte-identical to a
fresh deterministic reduction of the same parent, result, and fuel.

The standalone Research Digest proof also loses the computed child before head
advancement, retains the exact capability result, recomputes identical child
Frame bytes, and confirms the research capability invocation count remains one.
Its replay branch consumes the retained result with zero fresh effects.
The `retry` and `replay` operator commands reject `--effect-result` and all
fresh handler metadata; only `resume` can admit a new external result. They
reuse the recorded fuel automatically and reject an explicit `--fuel` that
differs from that retained budget.
