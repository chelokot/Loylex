# Approval fetch diagnostics, 2026-11-24

Baseline: 4921078a39a09aad2fd119080eb7036268766bde. Operator request #1341354.
The host rejects gateway preparation with “Git fetch: git failed (exit 128):
unclassified Git failure”. The same anonymous fetch of that exact target, using
the broker's clean environment and unchanged prlimit arguments, succeeded in an
isolated bare repository in 0.71 seconds inside the agent container. This rules
out a missing target commit there; it does not establish the host's failure cause.
Host diagnostics are still needed before claiming a root-cause fix.

This change only expands fixed error categories, labels the target/installed SHA
at the failing fetch, and reports bounded command timeouts and launch errno.
Remote stderr, argv, credentials and URLs are never included. Unknown errors
remain generic. No dependencies, image pins, endpoints, resource limits,
authorization, execution or retry semantics change. All affected scripts are
already in the installed supervisor's update file set; no bootstrap import is
introduced. The category function moves unchanged in interface to the existing
supervisor error module to respect the hand-written file size limit.

Reviewed the complete source diff and import path. No network-controlled text is
executed; Git still fetches inert objects for a reviewable, commit-pinned approval
package. Existing package digest checks, operator button approval, deployment
health verification and rollback remain in place.

Apply through a commit-specific infrastructure approval. If that preparation
fails on the old broker, trusted host maintenance is required to install these
reviewed scripts; do not bypass the approval or container/host boundary.
Rollback is the same reviewed infrastructure operation targeting the baseline
commit, preserving the audit and approval records. Tests cover the safe category
mapping, no stderr/argv leakage, timeout and launch errors, both fetch boundaries,
and existing approval, authentication and deployment behavior.
