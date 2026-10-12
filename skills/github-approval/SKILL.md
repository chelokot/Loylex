---
name: github-approval
description: Propose GitHub writes or gateway and host supervisor updates for operator approval through the host broker.
---

# Approval requests

Anyone may propose an operation. Only the operator's live Telegram button press executes it.
Ordinary Git access to chelokot/Loylex and `loylex system deploy agent` remain available.
Never seek, read or copy the broker's GitHub, Telegram or gateway-supervisor secrets.

Write JSON with `jobId` from Request metadata `job_id` and an `operation`.
Run `loylex approve submit REQUEST.json`, then `loylex approve status ID`.
The host sends the immutable full package, advisory TLDR of up to 50 words and buttons to
that job's chat. Report pending as awaiting approval; check succeeded and the remote result.

Git diff preflight reads public repositories without credentials. Private repository API
writes are available; private Git push/PR preflight is not supported.

Supported operations:

- Push: `{"kind":"push","repository":"owner/name","ref":"refs/heads/branch","newSha":"FULL_SHA","bundle":"BASE64_GIT_BUNDLE"}`.
  Build with `git bundle create change.bundle HEAD ^BASE_SHA`; omit the exclusion for
  a new repository. Existing branches must advance without removing history; existing tags
  cannot be replaced. A moved target fails its lease and needs a new request.
- PR: `{"kind":"pull-request","repository":"owner/name","head":"branch","base":"main","title":"Title","body":""}`.
  Both branches must exist in that repository. Their SHAs are checked again before creating
  the PR. Push and PR creation are separate approvals.
- Repository API: `{"kind":"github","repository":"owner/name","method":"POST","resource":"releases","body":{...}}`.
  POST/PATCH/PUT/DELETE support issues, releases, repository dispatches and workflow operations.
  PR mutations, credential endpoints, arbitrary URLs and shell commands are unavailable.
- Gateway: `{"kind":"gateway","commit":"FULL_LOYLEX_COMMIT_SHA"}`. The host builds reviewed
  source with a snapshotted base digest and rolls back on failed health verification.
- Host supervisor: `{"kind":"infrastructure","commit":"FULL_LOYLEX_COMMIT_SHA"}`. Updates only
  deploy/scripts/loylex-supervisor and deploy/scripts/loylex_approvals.py, then restarts it.
  Compose, systemd units and host packages still require host maintenance.

Requests expire one hour after creation. Limits: three active per chat, ten total, thirty per
hour, 20 MiB per bundle and 8 MiB per full package. Failed or interrupted execution is never
automatically retried: inspect the remote state before submitting a replacement.
