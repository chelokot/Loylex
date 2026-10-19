# Fork contribution comparison review — 2026-10-19

Baseline c084fd4. The incident was not a transport-size problem. A new branch in
chelokot/pm3 was compared to the fork's stale default HEAD f802e87, so the upstream
Rust rewrite was presented as part of the contribution. The gzip workaround is
reverted; all documents are plain operation.txt again.

New fork branches now resolve their parent from GitHub public repository metadata,
fetch its published HEAD, and compute merge-base(upstream, proposed head). The
review contains the contribution's commits and final diff from that base. Parent
repository, upstream SHA, merge-base SHA, fork HEAD, destination and exact proposed
SHA are saved in the immutable package. Existing branches and tags retain their
previous comparison and lease behavior. Missing/invalid metadata, absent parent
HEAD, unavailable prerequisites or unrelated history fail instead of guessing.
The destination default branch is never synchronized or changed by this feature.

Complete broker diff reviewed. No versions, dependencies, vendored artifacts,
build/install scripts, credentials, authorization or update mechanics change.
The only additional request is inert public JSON at api.github.com/repos/owner/repo
(no credentials), followed by existing restricted Git fetch/merge-base operations.
The returned parent is validated as owner/name; it cannot supply shell commands,
change the destination or authorize execution. Existing process, memory, timeout,
network-redirect restrictions, digest binding and rollback remain in force.
Residual risk: comparison context depends on GitHub's published fork metadata;
the exact context is exposed for approval and no caller-provided base can suppress
a diff. API failure prevents preparation of a new branch request.

Verification: replayed the exact original pm3 bundle without checkout or execution.
The corrected package is 4,385 plain-text bytes and one contribution commit, versus
1,471,405 bytes and six commits previously. Regression tests reproduce a stale fork
whose bundle prerequisites are only in upstream, verify the contribution-only
package and actual push, and ensure the fork default stays unchanged. Existing
branch review still includes all changes. Metadata transport and invalid/error
responses are tested. Full repository checks and git diff --check run before push.

Apply via a commit-specific infrastructure approval. Revert this change and submit
that commit via the same approval path to roll back. The earlier pending gzip
approval is obsolete and must not be used to apply this fix.
