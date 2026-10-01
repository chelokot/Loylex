# Contextual Leylobucks assessment — 2026-10-01

Problem: the previous word/keyword formula charged 12 bucks for the appropriate
reply “Не меняй, всё правильно”. It rewarded padding, not conversational value.

The worker now evaluates the current message against its explicit reply target and
bounded recent same-chat context, using the already configured Codex model. Native
Rich Telegram replies can omit bot text; the scoring context recovers the saved
answer only through the exact same-chat outbound message ID, with no author-based
lookup or substitution of a nearby message. The
rubric rewards originality, substance, insight, interesting questions and apt
humour. Appropriate routine confirmations are neutral or slightly positive.
The score remains subjective; this is not an intelligence measurement. JSON
validation bounds scores to integer 0–100 and explanations to 500 characters.
The unchanged monetary conversion is clamp((score - 50) * 2, -100, 100).

Admission records a pending zero-delta transaction. Completion settles once in an
immediate SQLite transaction against the current account balance, preserving any
intervening purchases/rewards. Existing scored jobs are never rescored. Cancelled
or failed jobs incur no assessment charge. Retries cannot settle twice. Failed,
timed-out or malformed evaluation is neutral and explained in the footer.
No schema migrations, balance rewrites or historical transaction edits are used.
Previously admitted concurrent jobs can finish after the balance becomes negative;
subsequent admissions retain the existing negative-balance gate.

## Integration review

No dependency, base image, runtime version, CI, registry, credential, supervisor,
authentication or deployment ownership changes. Codex stays at the reviewed
0.159.2 pin in `containers/agent.Containerfile`, with wrapper SHA256
cf1e5d7b6e317a4a1d36dbff2ebd9b3cf048ac98d06fcb6682c57248e023cad2 and
Linux x64 artifact SHA256
84a6b35fb45bdcb94cef9fcb329438045a8911f53876cc9a9a7e6f9bb1382eba.
The prior full artifact review remains in `deploy/host/codex-0.159.2-audit.md`.
The new integration uses that installed binary, with no runtime downloads or
package installation. `COPY src` places the reviewed source in the agent image;
`src/agent/main.ts` imports the evaluator directly. Gateway settlement is reviewed
source in its existing image path. The complete evaluator has been inspected.

Invocation is a fixed argv array, without a shell; conversation text enters only
stdin and can never choose executable paths, flags, model, account or job ID.
The evaluator has a read-only sandbox and never inherits the bridge token or
gateway environment. User config/plugins are not loaded; shell, unified exec,
code mode, apps, multi-agent and web tools are disabled. Startup updates remain
disabled. The evaluator output is inert, validated JSON, never code to execute.
Unexpected tool events invalidate the score. Official CLI documentation:
https://developers.openai.com/codex/noninteractive and
https://developers.openai.com/codex/config-reference.

One additional model call per economy-enabled successful response adds latency
and consumes existing account quota. It shares the configured worker concurrency
bound, has a 45-second deadline, TERM/KILL cleanup, a 128 KB capture limit,
ephemeral sessions, and job-local temporary schema cleanup. Its token usage is
included in the job totals. No private memory is given to the evaluator.
The normal response runner and all host isolation/health/resource settings remain
as before. Inference failure yields a neutral assessment without failing the answer.

Validation: isolated fake-child tests cover fixed arguments, environment isolation,
malformed output, unexpected tool events, cancellation and timeout. Disposable DB
tests cover pending admission, intervening balance changes, retry idempotence,
overflow rollback, cancellation and the negative-balance gate. Live samples gave
55 for the appropriate short confirmation, 20 for keyword stuffing, and 86 for a
contextual Civilization joke, without changing any Telegram balances. Full repo
checks are required before push. Deployment uses the existing pinned-image
supervisor after the main image workflow succeeds.

Rollback: a reviewable revert and rebuilt image restore the previous scoring
implementation without data migrations. Pending zero-delta jobs are safe on an
older worker/gateway; old already-assessed jobs remain unchanged on a new worker.
Existing audit logs, transaction history and authentication are preserved.
