# Approved GitHub fork creation

Reviewed 2026-11-09 for the operator's request to prepare upstream contributions without
manually creating each fork. This changes the existing host broker's GitHub resource
validation, not its execution, callback authorization, credential handling or deployment path.

## Exact change and provenance

Baseline: Loylex commit 890b0de. No dependency, image version, runtime pin or installation
mechanism changes. The existing GitHub API operation gains only the exact `forks` resource
with POST, mandatory `default_branch_only: true`, and an optional validated repository name.
Organization selection, extra body fields, subpaths, traversal, alternate methods and arbitrary
URLs remain rejected. Omitting organization makes GitHub use the authenticated account;
the operator's existing host credential determines the destination and its permissions.

Contract: https://docs.github.com/en/rest/repos/forks#create-a-fork (reviewed 2026-11-09).
GitHub creates forks asynchronously and may return HTTP 202. A successful broker request
therefore means creation was accepted; callers must verify repository availability and the
public parent/source metadata before proposing a push. Existing repositories and branches
are not overwritten by this operation. GitHub decides naming conflicts and fork permissions.

The installed GitHub token is never read into the agent. Fine-grained credentials require
Contents read plus Administration write or Repository creation write, according to GitHub's
current documentation. Existing token permissions are unknown until an approved request is
executed. A provider rejection is reported by its HTTP status; no credential or permission
changes are attempted automatically.

## Execution and isolation review

The request still passes the immutable package, operator button, expiry, chat/message binding
and exactly-once execution path. `_github` continues to call only api.github.com without
redirects and returns only status, URL, number and ID; no raw API body or token is returned.
Source content is not downloaded or executed by forking. No network-provided commands,
install scripts, dynamic imports or executable updates are introduced.

The host update remains an approved commit-specific `infrastructure` operation. Its existing
preflight records the installed commit and SHA-256 of every supervisor module; execution
checks those hashes, copies the reviewed Git tree's allowlisted modules, then schedules the
supervisor restart. Gateway, Compose, host ownership, authentication, audit, health checks,
resource limits and volumes are unchanged. The agent image uses the existing pinned build
and normal supervised rollout. No new external service, package or vendored artifact exists.

## Verification and recovery

Tests cover exact package persistence, no GitHub call during proposal, refusal of another
user's callback, execution only after the bound operator callback, and no replay. Invalid
methods, missing/false/nonboolean branch flags, organization fields, malformed names and
fork subpaths are rejected. Existing approval/boundary tests cover tampering, cancellation,
expiry and the surrounding trust controls. Full `bun run check` passed: typecheck, lint, 263 TypeScript tests and 86 Python tests.
The first suite run hit the unrelated journal-only Codex-runner test with `Codex completed
without an answer`; its isolated rerun and the subsequent complete suite passed. No checks
were disabled and no unrelated runner code was changed.

Live provider permissions and asynchronous creation cannot be proven by mocked tests. After
installation, propose a single fork of telegramdesktop/tdesktop, wait for approval, then verify
chelokot/tdesktop and its parent before proceeding. Fork creation, contribution push and PR
creation remain separate approvals.

Rollback: submit a new reviewed infrastructure operation restoring the prior installed broker
commit, or commit a scoped revert and install it through the same mechanism. Retain the old
commit, packages and logs. Fork creation itself adds a repository; rollback does not delete it.
The existing infrastructure updater is not transactional across files and has no automatic
rollback; this change does not modify that existing risk. The old source and commit-specific
update path remain available for recovery.
