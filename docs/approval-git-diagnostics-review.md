# Git approval diagnostics review — 2026-10-12

Two approved UMM pushes failed with exit 128. Public refs were checked and neither
requested branch exists. The broker discarded stderr, so the original cause is
unrecoverable; authentication failure is not established.

This changes only failure diagnostics in deploy/scripts/loylex_approvals.py.
The old source is Loylex 22654ac; the replacement is the reviewed commit carrying
this document. No dependencies, versions, base images, artifacts, lockfiles,
network endpoints, installation commands, authentication, or update mechanisms
change. No vendored/generated code is introduced. No remote data is evaluated or
executed. Existing subprocess limits and host isolation remain intact.

The complete final source diff was reviewed. At most 64 KiB of stderr is read;
only fixed categories and allowlisted Git operation names reach Telegram/storage.
Raw remote output, arguments, URLs, credentials and authentication headers are
never returned. Unknown errors remain unclassified, so a category is diagnostic
rather than proof of a precise cause.

Validation: approval integration tests exercise local disposable repositories,
including successful pushes, immutable packages, authorization and deployment;
new tests cover categories, bounded input, and credential-shaped stderr exclusion.
Run the repository check before committing. Git diff --check must pass.

Installation: push the reviewed commit to chelokot/Loylex, verify Images for that
commit, deploy the agent, then submit a commit-specific infrastructure approval.
The existing broker installs only its two allowlisted scripts after the operator
presses its Telegram button. No direct host access is used. Resubmit failed pushes
only after checking remote refs and the diagnostic update is installed.

Rollback: submit a new reviewed commit reverting this diagnostic change through
the same infrastructure approval route; persistent approval records and bundles
are preserved. Residual limitation: old failures cannot be reconstructed and
unknown stderr patterns require trusted host investigation.
