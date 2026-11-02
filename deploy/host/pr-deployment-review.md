# PR deployment migration — prepared, not installed

Operator request: Telegram job 1773, following job 1772. The operator chose PR
review with a single Telegram TLDR/link/merge button, no document, and automatic
deployment after successful merge builds. This branch prepares that change; it
cannot install or expand host services from the isolated agent container.

## Implemented path

The Propose workflow opens/reuses a PR to main on `feature/**` pushes. It runs
only on GitHub-hosted infrastructure and requires the repository setting allowing
GitHub Actions to create PRs. It uses only its ephemeral repository token, fixed
API paths and inert branch metadata; no checkout, host credential, or third-party
Action is added. If repository policy denies PR creation the workflow fails and
that external setting must be enabled by the operator. No merge occurs there.

The broker accepts `{"kind":"merge-pr","repository":"chelokot/Loylex","number":N}`.
It snapshots both revisions and the complete reviewed head tree. Only same-repository,
open, non-draft PRs to main are supported. Main must already be an ancestor of the
head; update the PR when main advances. The existing live Telegram principal,
chat/message binding, expiration, cancellation, single execution claim, and mandatory
inbound audit are unchanged. Telegram approval is the approval; GitHub self-review
is not attempted. The merge API uses an exact head-SHA condition. Checks on the
reviewed feature head must succeed. Check also runs on feature pushes, because
PRs created by GitHub's own workflow token do not trigger another Actions run. Existing GitHub branch protections
continue to apply.

The immutable full package stays in host storage, with its checksum, but is no
longer sent as a document. Summary, GitHub link and buttons share one message;
decisions and deployment results edit that same message. Other operation kinds
keep their existing behavior, except for removal of the document and addition of
a link. Repository API operations link to the repository, not a nonexistent diff.

After merge, a host thread polls at 30 seconds only when explicitly enabled by
host bootstrap. It processes successful broker merge approvals, not arbitrary
main pushes. It requires Check and Images push runs for the exact SHA and main
branch. The merged Git tree must equal the approved tree. Superseded revisions
are skipped. Missing builds expire after two hours. Failed/interrupted installation
is not replayed; inspect and propose a fresh operation. Durable state is exposed
as `deployment` in approval status, separate from merge success.

CI publishes the exact agent/gateway image digests as inert commit statuses tied
to the Images run URL. The controller requires the GitHub Actions creator, exact
run, context, digest syntax and successful workflow before passing both digests
to the supervisor. Images are pulled by digest and their full revision labels
are checked before Compose changes. No mutable main/short-SHA tag is installed.
Existing health checks, blue/green agent activation and previous gateway image
rollback remain in use. Once a new agent generation registers, a failed old-worker
drain is reported for inspection rather than replaying the old generation.

## Host boundary and remaining scope

Automatic installation covers the agent and gateway images. It does **not** yet
implement arbitrary Compose, systemd, host-package or supervisor-code rollout.
A PR touching host scripts, Compose or units fails closed unless trusted host
bootstrap has installed/verified that exact reviewed tree. This deliberately
prevents a misleading successful result while host infrastructure remains old.
Full unattended host-infrastructure rollout from the original request remains
unfinished and requires a separately reviewed host-side installer policy.

There is no new listener, SSH key, Tailscale installation, self-hosted Actions
runner, Podman socket, host namespace mount or container privilege. No source or
shell script is downloaded and executed by the runtime controller. Source objects
are fetched only for pinned-tree comparison. Host module installation is an
explicit execution of local reviewed checkout code, outside the agent container.

## Bootstrap and recovery

As the existing rootless Loylex host user, obtain a clean checkout of the reviewed
branch/merged commit and run:

```
python3 deploy/scripts/bootstrap-pr-deploy.py FULL_REVIEWED_SHA
```

The script refuses agent-container execution and root, checks the exact clean
revision and each installed module against its Git object, compiles modules in
a temporary directory, and requires no outstanding approvals. It compares actual
Compose (preserving deployed images) and systemd units against the reviewed
checkout. Differences require explicit host maintenance; it never invokes the
large system installer or installs packages as a side effect.

Before replacement it saves every existing target and a recovery manifest under
`~/.local/state/loylex-approvals/pr-bootstrap-TIMESTAMP/`. It stops only the
supervisor, atomically replaces its fixed module set, records the opt-in/tree,
starts the service and verifies the authenticated status endpoint and active
agent/gateway. A failed bootstrap restores the saved modules and marker files
and restarts the previous supervisor. Persistent volumes, logs, Git history,
audit, credentials and units are not replaced.

Manual rollback: stop the supervisor, restore each manifest path from the
numbered backup (remove only newly introduced manifest targets), then start the
supervisor. Keep the backup. For an application rollback, retain/reinstall the
previous image digests in host Compose using the existing supervisor procedure;
do not restore a database snapshot over live writes.

## Dependency/provenance review

Baseline source: 6be95b3c5de6de0cdc5bbbb4c57fffd46ad41e03. This is a deployment
integration change, not a dependency-version update. Bun, Codex, PM3, Podman,
Compose, base images and all existing Action versions remain unchanged. No new
third-party package or bundled/minified/generated executable artifact is added.
All new Python code is local, hand-written, standard-library code reviewed in
full with this branch diff, together with the existing supervisor execution,
approval, packaging, HTTP and Compose paths it calls.

New network endpoints are fixed GitHub REST paths under api.github.com for PRs,
checks, workflow runs, PR creation and inert statuses, plus existing GHCR image pulls. Images gets
`statuses: write` solely to publish digests; Propose gets `pull-requests: write` to open PRs; no host credential is sent to Actions.
The publishing script rejects redirects and validates repository/revision/digest.
The existing host HTTPS helper does not follow redirects and limits responses.
Remote data enters typed JSON comparisons and fixed subprocess argument arrays,
never a shell, dynamic import or evaluator.

Residual risks: existing workflow Action references are mutable tags; this change
does not upgrade or independently re-vendor those dependencies. CI/registry
compromise is outside an image revision-label check; binding a digest to the
successful run improves integrity but is not independent signed build attestation.
GitHub cannot atomically lease the base branch in the merge endpoint; a concurrent
base change can still merge, but a changed resulting tree cannot be installed.
The shared coding workspace may contain a different instructions file; existing
agent startup integrity checks then reject activation and retain the old generation.
There is no automatically enabled dependency/package updater in this controller.

## Validation

Full `bun run check`, Python integration tests with disposable local Git remotes,
mocked GitHub/Podman boundaries, and `git diff --check` are required before push.
Coverage includes live sender rejection, moved head/base, failing/pending/truncated
checks, summary/link/buttons without document, exact merge SHA/tree, failed/pending
builds, supersession, durable no-replay after failure/restart, digest substitution,
pre-activation rollback and retained registered generation after drain failure.
Host bootstrap and real Telegram merge/deployment have not been exercised: host
access and installation are required before claiming the migration complete.
