# Telegram approval broker, 2026-10-12

The host supervisor stores immutable packages in its own SQLite database and directories.
The agent's existing supervisor token cannot submit host callbacks, approve an operation,
or deploy gateway/all. Gateway requests use TLS with a pinned host certificate; the
privileged listener rejects agent credentials and the plaintext listener rejects gateway
credentials. A separate token is mounted only in the gateway, which forwards
callbacks after the existing mandatory inbound audit. Approval requires live callback sender
426043802, the original chat/message pair, pending state and an unexpired request.
The transition to executing is committed before the single execution attempt. Interrupted
execution is never replayed; inspect the remote result before making another request.

Pushes use host-owned bare repositories, disabled hooks/configuration/redirects, HTTPS-only
transport. Preflight reads public metadata without credentials; only approved execution
supplies the GitHub secret through process environment. Private Git preflight is unavailable. Packages include the
target, old/new SHAs, bundle checksum, new commit patches, target object and full binary tree
diff. Existing branches must fast-forward. Exact leases reject changed refs. PR packages
include branch SHAs and diffs; branch SHAs are checked again immediately before the API call.
Fork PRs snapshot and recheck the source branch in `headRepository` and the destination
branch in `repository`, then use GitHub's owner-qualified head and explicit source repository.
Omitting `headRepository` retains same-repository PRs. Operator consent does not add repository
write permissions to the configured GitHub account; upstream contributions use a writable fork.
GitHub cannot atomically bind PR creation to those SHAs, so concurrent changes by another
repository writer during that call remain a provider limitation.

GitHub API writes use a fixed hostname, no redirects, explicit repository paths and a
restricted resource set. Only status/URL/number/ID are returned. Credentials and arbitrary
host commands are unavailable. Agent APIs cannot edit/delete either approval document or
button message, change webhooks, consume updates, or delete their forum topic.
The guard and notification share a host lock to prevent edits before message IDs are saved.

TLDR runs the existing pinned agent image in a disposable, read-only container, with CPU,
memory/PID limits, no agent workspace or privileged secrets, and a temporary copy of Codex
authorization. Codex ignores user configuration, disables tools and produces JSON events;
unexpected tool events invalidate the advisory review. The summary is limited to 50 words.
Authorization copies retain owner-only permissions and the reviewer uses the host owner's
UID mapping. Conmon independently kills it after 180 seconds, including supervisor restarts.
Review failure leaves the complete package available for manual approval.

Gateway deployment snapshots the complete source diff and uses the base digest installed
by trusted host maintenance; preparing a proposal never pulls arbitrary candidate images. The host builds that saved recipe from the approved Git object,
then verifies health with automatic rollback to the previous Compose image. Gateway
rollouts retain the built image's content digest, so a missing local tag cannot pull substituted
CI bytes. Host supervisor updates copy only the two named Python files and check installed file hashes before replacing
them. Compose, service units and host packages require explicit host maintenance.
No runtime dependency versions are changed: Bun 1.4.0, Codex 0.159.2 and the existing host
Podman/Compose/PM3 installations are retained.

Verification covers real local Git bundle/push execution, concurrent ref changes, tampered
packages, author/chat/message binding, expiration/cancellation/restart behavior, broker HTTP
authentication, JSON/multipart/dedicated Telegram mutation routes, and the existing suite.
Bootstrap backs up installed supervisor and Compose, builds gateway from the reviewed commit,
and installs only the new module/token and gateway configuration. Rollback restores those
files and the previous gateway image; persistent volumes and inbound audit are preserved.
