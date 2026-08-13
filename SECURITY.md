# Security policy

Report security vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/tkersey/world-host/security/advisories/new).
Do not post credentials, exploit details, private repository data, Frames,
EffectResults, runtime stores, or live provider transcripts in a public issue.

The supported release line is world-host v1.x. Carrier v0 is legacy and
receives only correctness and compatibility fixes.

Boundary and World own portable computation and application semantics.
world-host owns Application ABI v1 admission, Frame and EffectResult custody,
branch heads, disposable workers, retry, replay, branching, migration, and
operator tooling. Report a defect here when it crosses that host boundary;
report a portable Machine or application semantic defect to its owning
Boundary or World repository.

Receiver policy, credentials, capability bindings, and external authority are
deployment inputs. They are not part of this repository or its release
artifacts. Public source does not make a receiver's policy universal.

Maintainers do not promise a response time that is not operationally backed.
