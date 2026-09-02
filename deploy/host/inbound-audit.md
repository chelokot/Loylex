# Inbound Telegram audit due-diligence record

Reviewed: 2026-09-02

Decision: approve a host-prepared append-only audit file for the gateway's inbound Telegram
messages. This is a security audit trail, not the normal SQLite archive and not a replacement
for the archive's existing privacy behavior.

## Recorded data and ordering

The gateway writes one NDJSON record for each `message`, `edited_message`, `channel_post`, or
`edited_channel_post` update before `archiveUpdate` runs or the update offset advances. Each
record contains only:

- the schema version and gateway receipt time;
- Telegram update, chat, message, thread, and message timestamp IDs;
- the numeric `message.from.id` when present, or `sender_chat.id` for a channel post; and
- the message text or caption.

Names, usernames, raw updates, media objects, file IDs, and attachments are deliberately not
copied into this audit trail. The audit write is independent of the SQLite archive's chat
filters, so an excluded archive chat cannot bypass the internal audit.

## Storage and enforcement

The host installer creates the external `loylex-audit` Podman volume and the exact
`inbound.ndjson` file. The gateway receives that volume at `/audit` with write access; no agent
container receives it. The installer prepares the volume with these controls:

- the file is a regular file with no additional hard links;
- the gateway image's `bun` UID (`1000`) owns the file and has only the owner write bit;
- the volume directory is owned by container root and mode `0555`, preventing the gateway user
  from creating, renaming, or deleting entries; and
- the host sets Linux `append-only` (`chattr +a`) and verifies it with `lsattr`.

The application opens the existing file with `O_WRONLY|O_APPEND|O_NOFOLLOW`, never creates or
truncates it, serializes concurrent writers, and calls `fsync` after each complete record. A
missing, substituted, non-regular, unwritable, or failed audit path prevents startup or stops
the poller before its offset advances. A retry may duplicate a record after a crash; analysts
should deduplicate by `update_id` and retain an incomplete final line as evidence of an
interrupted write.

The append-only flag protects the container-facing file from ordinary truncation and
replacement, but it is not protection from a host administrator who can clear filesystem flags
or destroy the whole host. The agent container cannot inspect or configure the host filesystem;
the host installer and host operator remain part of this trust boundary.

## Host verification

After installation, the host operator should verify the exact volume and file before enabling
the gateway:

```bash
audit_mountpoint="$(runuser -u loylex -- env HOME=/home/loylex XDG_RUNTIME_DIR=/run/user/$(id -u loylex) \
  podman volume inspect --format '{{.Mountpoint}}' loylex-audit)"
sudo lsattr -d "$audit_mountpoint/inbound.ndjson"
sudo stat --format '%F %h %a' "$audit_mountpoint/inbound.ndjson"
```

The mountpoint can differ if the rootless storage path is configured differently; use the path
printed by `podman volume inspect`, and confirm that `lsattr` contains the `a` flag, `stat`
reports a regular file with one hard link, and the mode is `0244`. The installer refuses an
unexpected mountpoint, symlink, hard-linked file, unsupported filesystem flag, or failed setup.

The daily host backup exports `loylex-audit` together with the other named volumes. Those
compressed snapshots follow the existing 14-day backup retention policy; the live primary audit
file is not rotated or deleted by the container or backup job.

## Rotation and recovery

Do not rotate the file while the gateway is running. To rotate it, stop the gateway through the
host's normal PM3/systemd procedure, preserve the old volume export and file as a separately
named host artifact, create a new empty `inbound.ndjson` through the reviewed installer logic,
set its owner, mode, and `chattr +a`, verify it with `lsattr`, then start the gateway and confirm
that the first new record appears. Never truncate, replace, or clear the primary file as a
recovery shortcut. If the append fails, keep the gateway stopped, preserve the file unchanged,
and investigate the filesystem, SELinux label, mount, and free space before retrying.

## Residual risk and rollback

The audit is intentionally minimal and is not cryptographically tamper-evident: a privileged
host administrator can still alter the volume, and a compromised gateway can append misleading
records. It materially narrows the ordinary container attack surface and preserves evidence
before application-side privacy filters or processing.

Rollback is a reviewed revert of the application/deployment commit followed by a normal host
deployment. The `loylex-audit` volume must remain preserved during rollback; do not remove it or
disable the fail-closed check merely to boot an older image. If the older image does not know
the mount, leave the volume unattached but preserve it and restore the audited image as soon as
possible.
