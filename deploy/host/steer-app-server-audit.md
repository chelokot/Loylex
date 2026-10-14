# Telegram steer and local Codex app-server integration review

Reviewed: 2026-10-14. This adds `/steer Message` to the existing reply-based task
controls. It changes the text worker transport from `codex exec --json` to a
private `codex app-server --listen stdio://` process for each job. Assessments
retain their existing exec path. No dependency, image base, installation pin,
registry, supervisor, deployment definition, or updater version changes.

## Provenance and installation

The old and new transport both use the already pinned Codex CLI 0.159.2 binary.
Its source commit is `ff6aec96948b70d94983af2641a6b67c94faeff5`; exact wrapper
and native package checksums, signature/attestation verification, release workflow,
transitive package review, and known advisory limitations are recorded in
[codex-0.159.2-audit.md](codex-0.159.2-audit.md). Those image pins are unchanged.
The installed native executable SHA-256 is
`1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`.

Reviewed the pinned upstream `app-server/src/request_processors/turn_processor.rs`
steer implementation: `expectedTurnId` is required, the thread must be loaded,
input size and direct-input eligibility are checked, and core `steer_turn` accepts
only the identified active turn. No-active-turn and mismatched-turn requests fail
explicitly. Reviewed `app-server/src/transport.rs` and the installed binary's
locally generated protocol types for initialize, thread start/resume, turn
start/steer/interrupt, item events, and token usage, plus `token_usage_replay.rs` to exclude the historical usage
snapshot on resume. The official protocol is
[documented here](https://learn.chatgpt.com/docs/app-server).

No generated protocol bundle or downloaded upstream executable/source enters the
image. The complete new handwritten client is `src/agent/codex-app-server.ts`,
loaded by the existing built-in worker source COPY/import path. It invokes the
existing binary with a fixed argv using Bun.spawn; steering input travels as
JSON text over its private stdin and is never used as shell/process/import code.
It disables runtime update checks. Installation and updates remain reviewed,
pinned image builds, with no runtime code fetch or new network-controlled loader.
The model/network endpoints and credentials remain the installed Codex config's
existing ones; no new listener, remote daemon, account endpoint, or secret is added.

## Isolation, persistence, and failure behavior

- One stdio child per job; the server-issued thread and turn IDs are retained.
  Steering uses `turn/steer` with `expectedTurnId`, never interrupt/restart/resume.
- Model, reasoning effort, service tier, repository cwd, approval `never`, and
  sandbox `danger-full-access` preserve the existing isolated agent settings.
  Agent instruction integrity checks, host isolation, gateway bearer validation,
  inbound audit, authentication extraction, and operator checks are unchanged.
- Current steering sender metadata comes from the existing live-message user
  extraction. It uses the existing buildPrompt and never inherits the original
  requester's identity. Replies and Telegram forum topics are retained.
- An additive SQLite queue persists input for the same active targets as stop.
  Only the owning worker reads/acknowledges it. Message/job pairs are unique;
  bridge acknowledgement retries do not resubmit already accepted input within
  the running worker. Client IDs identify submissions but are not claimed as
  an upstream exactly-once guarantee.
- Commentary, terminal/tool events, final answer, current-run usage, saved-thread
  resume, and thread-writer retry behavior are preserved. Optional journal
  extension failures do not fail a task. Unsupported interactive server requests
  receive explicit errors rather than invented answers.
- Stop sends turn/interrupt, with bounded process termination fallback. Stderr
  is continuously drained into a bounded 4 KB tail; RPCs have a 30-second timeout.
  Existing service health checks, resource limits, persisted volumes, worker
  ownership/leases, and blue/green drain ordering are unchanged.
- Empty input gets usage, missing/completed targets are rejected, rejected
  steering is reported, and input still pending when a job finishes is marked
  failed with a Telegram notice. The optional queue endpoint being absent during
  the staged rollout does not fail ordinary jobs.

## Validation, limitations, rollout and recovery

The deterministic stdio fixture exercises same-turn steering, resume options,
commentary and command events, usage excluding previous turns, explicit steer
rejection, and cancellation. Database and gateway tests cover reply/thread
selection, worker ownership, duplicates, completed jobs, malformed delivery
acknowledgements, and forum topic preservation. The full repository check is
run before push. An authenticated isolated Codex smoke accepted a live steer
and returned `STEER_OK` instead of the initial requested `ORIGINAL`, retaining
one thread/turn. A separate live test resumes that saved thread and interrupts
a terminal operation: it returned `CodexCancelledError` in 79 ms after the
command-start event. The full check passed typecheck, lint, 247 Bun tests, and
35 Python tests.

Residual risk: app-server protocol is experimental; unsupported interactive
requests fail explicitly. A transport timeout can leave submission outcome
uncertain and is reported as a delivery failure rather than automatically
replayed. Upstream Rust tests are not run (Cargo is not installed); local
integration tests and the actual installed-binary smoke are the validation.
The existing Codex package/advisory limitations remain as documented previously.

Rollout: push the reviewed commit to chelokot/Loylex main, wait for its Images
workflow, then `loylex system deploy agent`. Gateway installation needs a
commit-specific host-broker operator button approval, so submit that exact SHA
using `loylex approve submit`. Until gateway approval `/steer` is unavailable.
Existing running jobs drain on their old worker; steer support applies to jobs
started by the new worker. Verify supervisor health and command acceptance.

Recovery: revert this feature commit with a normal reviewable commit and rebuild;
the supervisor retains the previous image for rollout failure recovery. Existing
jobs, Codex sessions, memory, and archive are preserved. The unused additive
queue table may remain after rollback. No database deletion or history rewriting
is needed.
