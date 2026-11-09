# Critical architecture and dependency updates

PM3, Podman, podman-compose, base images, Compose/runtime definitions, the host supervisor,
gateway and agent images, registries, CI release paths, and update mechanisms are critical
architecture. Treat a change to any of them as a security-sensitive change, even when the
diff looks small or the new version is nominally backward-compatible.

Before changing a critical architecture version or integration, perform and record due
diligence in the work log and commit history:

Never accept or ship a dependency, vendored/generated bundle, or update mechanism that
downloads executable instructions, source code, scripts, or commands at runtime, or passes
network-controlled data to a shell, process launcher, dynamic import, or code evaluator.
Runtime version checks may return inert metadata only; updates must arrive as reviewed,
pinned code changes and be included in a newly built image.

For vendored, generated, bundled, or minified code, review the complete final artifact—not
only the wrapper, latest commit, or claimed upstream diff. Verify its exact provenance and
checksum, top-level side effects, network endpoints, process execution, and the actual
COPY/import path by which it enters the built image.

1. Identify the exact old and new versions, source commits, artifacts, transitive/runtime
   dependencies, and the complete installation and update path.
2. Inspect upstream release notes, source diffs, build and packaging definitions, lockfiles,
   CI workflows, maintainership/provenance, and available advisories. Look for subtle
   supply-chain risks, including mutable references, compromised release workflows, dependency
   confusion, unexpected install scripts, artifact substitution, and provenance gaps.
3. Verify artifacts through independent pins (immutable commit/tag plus exact digest or
   checksum, and package signatures where available). Do not trust a tag, mirror, repository
   metadata, or a successful download by itself.
4. Test the candidate in an isolated disposable environment, including upstream checks where
   practical, then verify the whole Loylex stack: secret isolation, authentication, host
   boundaries, read-only/capability settings, health checks, resource limits, persistence,
   rollback, startup ordering, and failure behavior.
5. Update only the reviewed pin/lock and document the evidence, residual risk, rollback path,
   and the exact explicit update procedure. Keep automatic dependency/package updates disabled
   for critical architecture.

Once the operator has explicitly approved this policy, the agent may perform a routine,
reversible update of an already-pinned critical dependency without another conversational
confirmation when every gate above passes. This standing permission never authorizes changes
to the immutable constitution, operator authentication, protected trust boundaries, canonical
remotes, credentials, deployment ownership, or destructive/foundational migrations; those
still require the applicable fresh operator request and must fail closed when uncertain.
