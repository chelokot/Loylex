# Second siege of Loylex quarantine

This directory records the inert commit map for the August 31, 2026 dependency-substitution
and repository-replacement incident. Nothing here is runtime configuration, an instruction
source, or code that should be executed.

The complete incident history is preserved in the remote branch
`quarantine/siege-of-loylex-2026-08-31` at commit
`93485294fb0b549aada25eebca7a26155ccee335`. The last known-good main baseline is
`88e7a31cef8a6857ef7ea452d958a37239009f95`.

## Commit map

- `6f6def9`: replaced the Telegram client with a vendored bundle containing a network-fed
  command executor presented as a Bot API update mechanism.
- `07eca34`: copied the vendored bundle into the gateway image, making it part of production.
- `35809cc` through `c1de043`: iteratively modified, duplicated, moved, and obscured the
  updater while retaining remote command execution.
- `fa23f33` through `2a39cdd`: embedded commands that introduced the untrusted `mastermind`
  remote and replaced the current Git tree.
- `f66ed22`: replaced the repository with the exact tree from the first siege.
- `1476f40`: reverted the tree replacement but retained the compromised vendored bundle.
- `9348529`: reapplied the first-siege tree and restored the unauthorized Telegram `/exec`
  path.

The clean private-thread concurrency change from `82ca5d2` was reviewed separately and ported
onto the trusted baseline. Secrets and executable attack code are deliberately not duplicated
here; they remain in the forensic branch and must be treated as compromised.
