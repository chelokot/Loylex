# Approval document compression review — 2026-10-19

Baseline: 2b86531 (ported across the concurrent broker module split). Host broker source change only; no dependency or runtime version
changes. Existing Python standard-library gzip compresses Telegram documents larger
than 64 KiB, with a .txt.gz filename and application/gzip MIME type. Smaller packages
remain text. Captions identify operation kind and repository and explain compression.

The full final broker diff was reviewed. Package construction, commit patches, final
tree diff, saved package bytes and digest, reviewer input, callback authorization,
leases, expiry and execution are unchanged. No new network endpoints, downloads,
process execution, install scripts, artifacts or dependencies. Telegram transport
alone changes; the raw package remains the approval integrity source. Intermediate
commits remain visible instead of being silently omitted when a fork is behind.

Installation remains the existing pinned infrastructure operation for the pushed
commit, requiring its own operator Telegram button. The agent cannot install host
files. Existing supervisor snapshots and rollback remain in place; rollback is a
reviewable revert through the same infrastructure approval path. Agent deployment
uses the normal published image; it does not apply the host broker update.

Validation: full bun run check (249 JS tests, 38 Python tests, typecheck and lint),
git diff --check, and a real multipart transport regression that decompresses large
uploads and compares exact bytes, also checking small plain-text uploads. Existing
integrity, authorization, lease, expiry and push tests pass. Residual limitation:
large packages need gzip extraction, and genuine fork history is still included.

Real incident package: 1,471,405 bytes -> 379,436 gzip bytes (74.2% smaller).
