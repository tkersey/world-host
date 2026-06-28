# Agent Runtime Examples

These examples are Carrier-side Agent Closure fixtures. They do not define the
agent loop and do not mint World evidence. They install an agent-shaped
Executable.Image record, resolve external model and file HostRequests through
deterministic drivers, persist ResolutionInputs through `EffectJournal`, and
advance or inspect Carrier branch heads only after closure bytes are retained.

The semantic proof that Boundary agent module bytes are sealed into World
Executable.Image and run through the universal WASM remains the World
`dist-world-agent-v0` gate.
