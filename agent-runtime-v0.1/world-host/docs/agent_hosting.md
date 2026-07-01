# Agent Hosting

The agent is not a host loop. The agent is a Boundary program. World turns it
into portable execution. world-host operates the resulting process.

## Installing Agent Executable.Image

Carrier installs an agent-shaped `Executable.Image` as immutable bytes together
with the released World universal WASM and Appliance manifest. The host records
the image, manifest, run, branch head, receiver-local policy, and required
actuators. It does not parse Boundary `ProgramPlan` semantics and does not
define an application Target type for the agent.

## Fixture Model Driver

`FixtureAgentModelDriver` is a deterministic conformance driver for the external
`model.decide` Actuation boundary. It accepts `Agent.DecisionPrompt` bytes and
returns `Agent.Action` value-image bytes for skeleton, fixture, malformed, and
unknown-tool scenarios. It has no network, credentials, randomness, or real LLM
provider behavior.

## Sandbox File Driver

The fixture file lane reuses `SandboxFileDriver` for bounded read/write effects
under a configured root. Path traversal, symlink escape, unsupported statuses,
oversized requests, and missing driver coverage remain fail-closed at the driver
and preflight boundaries.

## Capability Preflight

Agent runs use receiver-local policy. Required model and file actuators must be
covered by local drivers before execution or import. Migration reapplies
receiver-local preflight and does not import sender authority.

## Running The Agent

Carrier executes the released universal WASM through its worker/controller
surface and resolves only external HostRequests. The skeleton lane resolves
fixture model decisions and records that toolbox routing is internal to the
Boundary/World closure. The fixture lane resolves model decisions plus sandbox
file read/write requests and verifies the output file after restart.

## Replay

Replay uses retained Carrier effect and closure records. Covered model/file
effects are not freshly invoked during replay; replay receipts record
`fresh_called=false`.

## Retry

Retry after a lost TurnClosure output reuses the persisted `ResolutionInput` for
the same World idempotency key. The sandbox write is not repeated.

## Migration

Migration exports the selected Carrier run, imports it into a new store with
receiver-local preflight, continues from the imported head, and leaves the source
run unchanged.

## Inspection

Completed runs are inspected from retained store records and immutable closure
bytes. Inspection does not execute the worker or invoke drivers again.

## Security Notes

world-host does not mint World receipts, TurnClosures, Capsules, Chronicle
events, or Archive evidence. It persists host `ResolutionInput` bytes before
World submission and advances branch heads only after closure bytes are retained.

## Non-goals

Agent Hosting v0 does not add real LLM providers, a production tool registry,
package discovery, a scheduler, a daemon, remote module fetching, branch merge
semantics, signing, encryption, or exactly-once effect claims.
