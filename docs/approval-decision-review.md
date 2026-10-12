# Approval decision on the original notice — 2026-10-12

Baseline a563b514. The tracked host broker now edits its original TLDR notice after
persisting an accepted decision, removing the inline keyboard and appending a
separate paragraph: ✅ Одобрено or ❌ Не одобрено. Approval denotes consent,
not successful execution; execution failures retain their separate notification.
The text is rebuilt from the saved review, never callback-provided message text.

The complete scoped source diff preserves sender checks, message/chat binding,
expiry, operation snapshots, execution and all deployment boundaries. No dependency,
artifact, pin, runtime download, endpoint or installation/update path changes.
The artifact is reviewed tracked Python source, delivered only by the existing
commit-specific infrastructure approval. Tests cover both decisions, exact edited
message and keyboard removal, duplicate/unauthorized callbacks, and Telegram edit
failure without reversing a durable decision or preventing execution. Full checks
also cover supervisor, audit and secret boundaries.

Residual risk: a failed Telegram edit leaves a stale button/notice; persisted state
still rejects repeat execution. Apply the exact commit using an operator-approved
infrastructure request, then verify its status and a subsequent live notice.
Rollback is a reviewed revert through the same approval path. Agent image publication
and deployment use the existing pinned workflow, without changes to build artifacts.
