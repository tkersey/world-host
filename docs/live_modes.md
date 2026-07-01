# Live Modes

Capability Plane v0.2 supports five modes.

- fixture: deterministic drivers only; default CI path; no network; exact golden behavior.
- dry-run: decode live HostRequests and report proposed actions without irreversible effects.
- shadow: run recorded or fixture output as authority; live output is diagnostics only and not submitted to World.
- approval: a driver proposes a resolution and an operator approves or rejects before submission.
- live: policy, secrets, preflight, journal persistence, and recovery class checks pass before resolution is submitted to World.

All modes preserve World validation authority, `EffectJournal` persistence before World submission, replay/retry behavior, and the no-host-authored-World-evidence invariant.
