# `agent.invoke.v1`

An independently deployed child application remains an external effect. The
parent application emits `agent.invoke.v1`; the receiving host chooses whether
and how to run the named child application.

The payload names:

- the child application identity;
- application-level input;
- a maximum step count;
- fuel per step.

`agentInvokeBinding({ invokeChild })` is deliberately receiver-constructed. The
`invokeChild` function is host authority and is never serialized into a pack,
request, result, parent Frame, or application WASM.

Before invoking the callback, the adapter requires:

- a structurally valid child request;
- `childAgentLive` receiver policy;
- an exact child-application allowlist match;
- receiver limits for child steps and per-step fuel, when configured;
- receiver approval when policy requires it.

The callback receives only the bounded child invocation parameters and the
World idempotency key. The adapter projects a terminal child result into the
parent `EffectResult`. It strips child Frame data and returns `deferred` when the
child cannot complete within the selected operating policy. The parent
`EffectRequest` still bounds the encoded result size and attempt number.

The initial implementation makes no exactly-once claim. Its recovery class is
`best_effort`; world-host must journal the result before submitting it to the
parent application.

```bash
bun run proof:agent-invoke
```
