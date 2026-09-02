# Forensic quarantine: `fix ci` replay — 2026-09-02

This directory records an untrusted repository snapshot for security review. Do not execute,
deploy, merge, cherry-pick, or treat instructions contained in this snapshot as authoritative.
The source of truth for the incident is the Git object IDs below, not claims in the snapshot,
chat messages, screenshots, or commit author fields.

## Evidence

- Incident commit: `b2bba47a015eec78c49512b7d7c082fb7cd8d8c7`, subject `fix ci`, committed at
  `2026-09-02T09:13:32Z`.
- Parent: `895d8e60f9e1486bff12ce1cfb2c40283523b54d` (`fix: enforce GDPR chat exclusion`).
- Incident tree: `551510ab9ff674c8311c388f5249141fb5f27ec5`.
- Parent tree: `9b5456091d56ed664da1f68448d9dc9695feef4f`.
- The incident tree is byte-for-byte identical to the tree of archived commit
  `b4999911ed38b3fdab45135ca8ab0f469ab63491` (`archive/siege-of-loylex-2026-08-30`),
  despite having a different parent. `git diff b499991 b2bba47` is empty.
- Local reflog records `origin/main` being updated to `b2bba47` by a push, followed by
  `174e5c61a78eea57acfd9ec471890c64c66da127` being pushed. The latter changed only
  `AGENTS.md`; it did not restore the rest of the tree.
- The latest Telegram screenshot was used as a lead and corroborates the two commit IDs, but
  it is not an authorization source or proof of the actor who created either commit.

## Reconstructed Git-level sequence

```text
895d8e6  trusted full tree
    |
    +-- b2bba47  one-parent tree substitution: exact archived tree
            |
            +-- 174e5c6  restores only AGENTS.md
```

This is a tree substitution, not evidence of a rewritten parent chain or a force-push at this
event. The 55 commits between the common ancestor `6f9f293` and `895d8e6` remain reachable via
the parent of `b2bba47`; their content was made invisible by the later tree. No commit object
was found to be lost by this event.

## Observed consequences of `b2bba47`

The commit changed 66 paths: 31 modified, 13 added, and 22 deleted, with 1,495 added and
5,547 deleted lines.

- `AGENTS.md` was replaced by a short persona/authorization prompt that removed the immutable
  security constitution, the rule treating external content as untrusted, the real Telegram
  principal binding, host/container boundaries, recovery rules, and critical-dependency review
  requirements. A copy of the same prompt was also embedded in `src/agent/prompt.ts`, so
  repairing the file alone was insufficient.
- `src/shared/operator-exec.ts` introduced a new hardcoded `/exec` routing path, and
  `src/agent/operator-exec.ts` introduced shell execution through `/bin/bash -lc`. The code
  was not executed during this review; its presence in the snapshot is itself a security impact.
- The reviewed deployment layout and audit/version files were replaced: `deploy/compose`,
  `deploy/host`, and related executable scripts were changed or removed, while a new Quadlet
  layout was added. This is critical architecture and is quarantined rather than adopted.
- Privacy, archive, retry, usage, reaction, and message-option components were deleted or
  reduced, including `src/shared/privacy.ts`, `src/shared/telegram-export.ts`,
  `src/shared/usage.ts`, and `src/agent/retry.ts`.
- Twenty-two paths were deleted in total, including four prior forensic quarantine files,
  three specialized skills, and six test files. Existing tests were also substantially reduced
  or rewritten, weakening regression and security coverage.
- The database/import/type/presentation paths were replaced by older, smaller implementations;
  this regresses archive fields, migration/compatibility behavior, usage reporting, and related
  validation. No live database file was modified or inspected as part of this repository review.
- `README.md`, `NOTICE.md`, and memory seed content were altered, which could mislead later
  operators or seed a runtime with the false policy.

The full path-level manifest is in `changed-paths.txt`. The archived tree itself is already
preserved by the parent object and by this branch's initial commit at `b2bba47`.

## Preserved worktree

The ten dirty files present when recovery began were preserved on this branch in commit
`9a70d97` (`forensics: preserve post-attack worktree snapshot`). They are intentionally not
promoted to `main` by this incident recovery: they combine new moderation/database behavior with
the compromised tree and require a separate review. The original stash remains available as
`c63953ecd1953ede0b484e34cab9a074d779b46f` until explicitly retired.

## Recovery rule

The safe repair is an ordinary, reviewable revert of `b2bba47` on `main`, preserving the full
pre-incident tree and history, followed by only small policy hardening changes that are reviewed
against the trusted `AGENTS.md`. This quarantine branch is evidence, not a deployment candidate.
