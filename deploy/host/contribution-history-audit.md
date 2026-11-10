# Bounded contribution history

Reviewed 2026-11-10 at the operator's request to make telegramdesktop/tdesktop contributions possible through the approval broker. The first push attempt failed during snapshot preparation with `Git fetch: git failed (exit 128)`.

## Exact change

Baseline: Loylex commit `ca19a99`, the installed broker. Changed files: `deploy/scripts/loylex_approval_packages.py`, `deploy/scripts/loylex_approvals.py` and their tests. No dependency, image, network endpoint, executable download or resource limit changes. The `prlimit` settings in `loylex_approval_host.py` (1 GiB address space, 128 MiB file size, 90 s CPU, 120 s timeout) are unchanged.

- Push and pull-request snapshots fetch `--depth 1000` below each fetched tip. Gateway, infrastructure and host-config snapshots keep the full history they had before.
- A bounded fetch of a commit already present in the snapshot repository transfers nothing.
- Finished requests (succeeded, failed, cancelled, expired, interrupted) lose their `repository.git` at the next submission. Pending and executing requests keep it, because execution pushes through it.

## Measurement

Under the broker's own limits, the full history of `telegramdesktop/tdesktop` exceeds the 128 MiB file cap: `exit 128`, `invalid index-pack output`, 129 MB written. Depth 1000 transferred 38 MB in 3 s, depth 3000 transferred 53 MB in 5 s, and depth 200 transferred 33 MB.

## Behaviour at the edges

- A new fork branch whose base is more than 1000 commits behind the upstream tip fails the merge-base step. The push is refused rather than reviewed against the wrong base.
- A pull request more than 1000 commits ahead of its base lists only the first 1000 commits. The final tree diff from base to head stays complete.
- Bundles still need their prerequisites in the repository, so unbundling cannot reach beyond the fetched history.

## Verification

- Approval tests: 25 pass, including bounded fetch arguments, discard after a request finishes, and skipping a commit that is already present.
- Full Python suite: 98 pass. `bun run check` passes with the container's proxy variables unset. `tests/claude-code.test.ts` expects no proxy and fails whenever `HTTPS_PROXY` is set. That is an existing environment dependency, unrelated to this change, and the test was not modified.
- The approval test remote now uses `file://`, so fetches exercise the same smart transport as GitHub. Before, local paths silently ignored `--depth`.
- Not verified here: the live GitHub transport and the installed broker. The `infrastructure` update and a new push request must prove that on the host.

## Bandwidth and disk

- A tdesktop-size snapshot transfers about 38 MB per distinct tip. Identical tips transfer once.
- Proposals are limited to 30 per hour and each pull request needs two fetches, so the worst case is about 2.3 GB per hour from GitHub for large repositories. This is not capped here. A per-repository mirror or an allowlist is the next step if it matters.
- At most ten active requests hold history, roughly 0.4 GB. Finished history is removed at the next submission.

## Rollback

Revert the commit and submit an `infrastructure` operation for the previous commit. Snapshot directories created by this change can be deleted; no other state depends on them.

## Residual risk

- The 1000-commit window is a judgement. Observed upstream movement was ten commits between 2026-11-09 and 2026-11-10, so fork branches older than roughly a hundred days fail closed.
- The infrastructure updater is not transactional across files, as recorded in `github-forks-audit.md`.
