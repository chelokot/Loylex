# T3 bridge due diligence — 2026-11-07

Scope: new host supervisor integration, proposed only. No running host, gateway,
image, Compose configuration, authentication extractor or operator callback is
changed by preparing this branch. No executable T3 package or SDK is installed,
vendored or imported. Python's existing stdlib and existing Podman secret helper
are the only runtime dependencies; all existing version/image pins stay unchanged.
There is no automatic dependency updater or runtime executable download.

## Exact upstream baseline

Protocol contracts and implementation were inspected at official
`pingdotgg/t3code` commit `25bf84ab07f53f141c20239c63e383823a9d5ea0`.
Review URLs use that immutable commit, not a moving tag. Local SHA-256 values:

| File under upstream | SHA-256 |
| --- | --- |
| `packages/contracts/src/orchestratorMcp.ts` | `a1a1f5ffc84c5cc151947db666069a440f1f4f15c96cdd6dabfbc0b9bae826d1` |
| `apps/server/src/mcp/toolkits/project/tools.ts` | `ccaba4a185d959ce0c3c0b812f23cbc5196e21dfa87349f06b15904b66bd0d6c` |
| `apps/server/src/mcp/toolkits/project/handlers.ts` | `0d7027332a51cf6d8e23222484daf50be263e61f8b2c665ccbe66dbdd4bb0284` |
| `apps/server/src/mcp/delegatedTaskModes.ts` | `041447811a67bcf62c2af83c4165572dae6dc90af51cf7e039f72b52f82b8909` |
| `packages/contracts/src/orchestrationV2.ts` | `9f791f7e75031f56c36fddabb2529913c2c4f1f539415037f9d7b9355dc597fb` |

Also examined outside-agent and remote-access documentation, the MCP registration
wrapper, orchestrator service and thread-access helpers. Findings: thread IDs use
colon-containing `mcp:` prefixes; launch has a `clientRequestId`; explicit
unsupported runtime modes fail rather than downgrade; wait returns status without
transcript, while task_status includes a summary. Consequently the free endpoint
uses wait, not task_status/read/list. Send inherits session mode and cannot
atomically condition dispatch on the checked mode/folder.

These checksums identify reviewed API source, not signatures or provenance for a
T3 executable. No claim is made that the future installed home-PC build matches
this source. Before activation, record its exact version/artifact provenance,
review applicable release/advisory changes and verify these contracts against it.
Any T3 installation/update is separate reviewed, pinned work; no runtime installer
or mutable package reference is added here.

## Final artifact and trust boundaries

The complete Python transport and policy code and all modified broker integration
sites are reviewed as source. Transport lives in the already installed
`loylex_approval_host.py`; operation policy lives in the already installed
`loylex_approval_validation.py`. No new host installation paths are needed. The
pre-T3 infrastructure installation list therefore ships the complete bridge. They are not copied into the agent image or
imported into agent/gateway code. Top-level effects are only constant definitions,
a bounded semaphore, a lock and an empty status-rate queue. There is no network,
secret read, process execution or credential registration at import time.

Network traffic: verified HTTPS to the exact host-registered T3 origin at `/mcp`;
existing host-to-Telegram notification flow and existing GitHub paths remain.
The transport never follows a server-provided URL. Remote data is JSON only and
never passed to a shell, process launcher, import or evaluator. The host's existing
fixed Podman secret-inspection helper supplies credentials from a registry-validated
secret name. No token is included in an immutable operation package or result.

The agent may submit proposals and metadata polls but cannot approve its own
packages or read the host registry/secret through the API. Current live callback
operator validation, audit ordering, supervisor authentication, deployment health
checks, limits and rollback remain unchanged. A task approved for full-access is
intentionally broad within the remote user's OS permissions. Approval of a read
releases the requested content to the agent; it does not cryptographically restrict
later Telegram destinations. Filesystem downloads are not implemented.

## Remaining activation gates and recovery

Local deterministic tests exercise the actual approval state machine with inert
remote responses plus the stdlib HTTP/SSE parser. Full repository checks passed
on the isolated PR worktree: `bun run check` (typecheck, Biome, 255 TypeScript
tests and 57 Python tests, including 17 T3 tests). After the final target-snapshot
privacy adjustment, all 17 T3 tests passed again; `git diff --check` passed. No secret-bearing upstream process is launched.
Live T3 tests, host secret isolation, revoked/expired OAuth handling and full-stack
startup/restart tests cannot be completed without the operator's MCP environment
and host provisioning. OAuth onboarding/refresh is explicitly not included yet.
The integration remains disabled/draft until those gates pass.

Update procedure: review the target T3 source/version, revise allowlists/contracts
in a new reviewed commit, run all checks, obtain commit-specific infrastructure
approval and verify the rollout gates in `docs/t3-approval-bridge.md`. Never auto
update T3 or replace remote protocol code based on returned metadata. Recovery
restores prior host supervisor modules and revokes the T3 grant; retain packages,
audit and history. This PR itself is rolled back by an ordinary revert.


## Bootstrap correction after PR #8

Before rollout, an isolated import probe with the **pre-T3 updater's exact file
list** reproduced `ModuleNotFoundError: loylex_t3_bridge`. The old updater, not the
candidate source, chooses which files to install. Adding new module names only to
the candidate list cannot bootstrap their first installation. PR #8 was not
deployed to the host.

The correction relocates the unchanged transport into `loylex_approval_host.py`
and the unchanged T3 policy into `loylex_approval_validation.py`; both are already
installed by the old updater. Candidate imports and test patches follow those
locations. The two standalone module paths and candidate-only list additions are
removed. There is no change to operator checks, credentials, runtime versions or
T3 policy. The exact previous file-set regression now imports the supervisor and
validates a T3 operation successfully in an isolated Python subprocess. Existing
installed-file hashes and package/commit approval semantics remain unchanged.

Correction validation: all 58 Python tests passed, including 18 T3 tests and the
previous-installer regression; `git diff --check` passed. The merged base commit
also passed its GitHub Check workflow. No host installation was attempted.

## OAuth onboarding and convenience — 2026-11-09

The merged base is `60c2874f495c497205acfaadfa91d7f4adbcbea6`.
The upstream contract review advances from `25bf84ab07f53f141c20239c63e383823a9d5ea0`
to official `pingdotgg/t3code` commit `2b65ffb641f152fadf443096bad7f4a0677caae4`.
The latter is a protocol source baseline, **not an installed executable pin**.
The public latest release metadata reports v0.1.7 (2026-11-04); the operator's
installed build is still unknown and must be verified before live acceptance.
No installed runtime/dependency/image/base pin changes in this work.

Reviewed OAuth contracts, issuer construction, registration, PKCE/redirect and
code exchange handlers, grant scopes, 30-day MCP-client lifetime and MCP-only
credential restrictions. Important corrections to the earlier proposal: upstream
supports only authorization_code, not refresh_token; Full access currently returns
four scopes (orchestration:read, orchestration:operate, settings:write,
source-control:write), while Auto lacks the last two. We reject a lesser grant
rather than silently accepting it. File HTTP APIs reject MCP-client credentials;
export therefore uses an explicitly approved autonomous task, not those APIs.

Exact inspected source SHA-256 values (raw official GitHub, immutable commit):

| Source | SHA-256 |
| --- | --- |
| `apps/server/src/auth/McpOAuth.ts` | `a08c370025d8423380819ed30e7ece5a97f135a69d7429b98b2caac390a1afcb` |
| `apps/server/src/auth/mcpOAuthHttp.ts` | `56f3b691cde1f6c3692f479cef4500cd5d268e635549dc8b77d4969bae69ea73` |
| `apps/server/src/auth/EnvironmentAuth.ts` | `8a2e41dd45597b8d2b8ba728015eebd08ffabf7630a49d47616371a533ba0c38` |
| `packages/contracts/src/auth.ts` | `afede6403875da53c432f92f947d38a074404553859c95bab2785c57d69a7b5e` |
| `packages/contracts/src/orchestratorMcp.ts` | `0b4b47f12e2377da2146b716c73c3e51f97cb0ccf2f690b932dca10b9f3d417a` |
| `apps/server/src/mcp/toolkits/project/handlers.ts` | `84d60cbf75b0519787da4019fe8c40764103ddca9ae67c3d6d4cfe1c0de20a4d` |

These hashes bind the inspected source independently of the mutable main name;
they are not upstream signatures and do not establish a desktop binary's provenance.
Inspected repository/package manifests, relevant CI and release metadata. Upstream
has native/SDK dependencies, ranges and install-time builds; none is installed,
vendored or executed by Loylex. The public security-advisories endpoint returned
an empty list on 2026-11-09; that is not evidence of absence of vulnerabilities.
A future local T3 installation/update needs its own artifact review, pin/checksum
and release/install-path audit. No runtime fetch/install/update mechanism is added.

Complete final implementation review: T3 transport/private file primitives live
in the existing `loylex_approval_host.py`; policy in
`loylex_approval_validation.py`; OAuth and bounded loopback callback HTTP in
`loylex_supervisor_http.py`. All are pre-existing installation paths. The exact
pre-T3 file-set subprocess regression verifies imports without any new modules.
No vendored/minified artifacts, SDKs, dynamic imports, network-controlled process
arguments or shell evaluation are introduced. Top-level effects are definitions,
locks and an OAuth object without IO. HTTP starts only in supervisor serve,
with valid host configuration. Network destinations are approved HTTPS origins
or the existing Telegram API; callback traffic goes through an operator-managed
TLS reverse proxy to loopback. Public DNS is pinned per connection and all answers
must be public, non-reserved and non-multicast. Remote OAuth URLs cannot redirect
registration/token exchange to another origin or path.

Secrets stay in host mode-0600 files using no-follow regular-file reads, owner
checks, size bounds, atomic fsync writes; no code/verifier/token enters packages,
results, browser output or agent mounts. Login state is random, PKCE is S256,
issuer/callback/configuration leases are checked, and exchange is single-use even
on network/storage failure. Reconnect changes grant identity to invalidate pending
operations. Partial persistence after a crash fails closed and requires reconnect.
Local disconnect cancels pending login but is not upstream revocation; use T3's
Sharing & access to revoke. Old credentials/audit remain preserved.

The CLI addition is source in the agent image. Its previously oversized entrypoint
required moving unchanged media commands to `cli-media.ts` to meet the repository's
file-size hook; routes, retry behavior and upload normalization are preserved.
Task-based export is deliberately bounded to 32 KiB. The prompt asks the remote
full-access agent to refuse escaping paths and secrets; it is not a filesystem
sandbox. Local saving checks approved-read state, exact path, complete content,
canonical base64, length and digest, refuses ambiguous exports, and never overwrites
an existing path. A remote computer can still lie about bytes/hash.

Validation includes the real broker's existing live-operator approval flow,
connect link notification only after approval, PKCE, wrong state/issuer, replay,
concurrent callbacks, expiry, narrower grants, changed registry leases, unknown
exchange outcomes, DNS rebinding/SSRF defenses, host file permissions/symlinks,
HTTP callback non-disclosure, project persistence/disconnect, export receipts,
CLI routing and exclusive local file saving. Full `bun run check` and
`git diff --check` are required before commit. No authentication extractor,
operator authorization check, audit route, Compose setting, limit or health check
is changed. Agent/gateway secrets and host isolation are covered by the existing
stack checks; live isolation/restart/revocation cannot be claimed without rollout.

Rollout needs the saved-commit infrastructure approval, agent image publication/
deployment, operator-managed public TLS callback provisioning, the actual MCP URL
and a human T3 login. Missing callback configuration leaves normal supervisor
service available and fails connect with setup instructions. These are explicit
external prerequisites, not completed live acceptance. No public supervisor port
is opened. Reverse proxy access/error/trace logging for the callback must be off.

Recovery: stop remote tasks, revoke the T3 grant, restore the previously recorded
supervisor commit/modules and backed-up registry through trusted host maintenance,
remove the exact callback proxy location if retiring the integration, keep all
packages/audit/history. No automatic retry of a mutation or code exchange; no
automatic T3 update. See `docs/t3-approval-bridge.md` for exact user/host steps.

Final local validation: `bun run check` passed (263 TypeScript tests, 78 Python
tests, typecheck and Biome); `git diff --check` passed. Live tests are still
blocked on the external host/T3 prerequisites described above.
