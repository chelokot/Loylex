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

The complete new Python transport and policy modules and all modified broker
integration sites are reviewed as source. The infrastructure installation list
includes both new modules, so the existing saved-commit infrastructure operation
ships the reviewed files together. They are not copied into the agent image or
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
