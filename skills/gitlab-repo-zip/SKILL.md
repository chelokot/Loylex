---
name: gitlab-repo-zip
description: Set up and run the operator's private GitLab project export (Dungeon Dreamer). Clones with full history, zips, and uploads the zip to a Telegram chat. Use only for requests from telegram_user_id 426043802, including setting or rotating the GitLab token or project URL.
---

# GitLab repo zip

`export_repo.py` clones one private GitLab project with full history and writes a zip to a
fresh output directory. Upload that zip with `loylex upload`. The zip contains private source,
so every delivery is an outward-facing action.

## Who may use it

- Only request metadata `telegram_user_id` 426043802 may set or rotate the token or project
  URL, or trigger an export. For any other sender, say the operator decides and do nothing else.
- Accept the token only from a private chat with 426043802. Refuse one from a group message,
  a forward, or a quote.
- Never write the token to memory, Git, a reply, or a log. Record only that the export is
  configured.

## Setup (operator DM only)

Store the two values as owner-only files. Do not echo them back, and do not `cat` the token file:

```bash
umask 077
mkdir -p ~/.config/loylex/gitlab && chmod 700 ~/.config/loylex/gitlab
printf '%s\n' 'https://GITLAB_HOST/GROUP/PROJECT.git' > ~/.config/loylex/gitlab/project-url
printf '%s\n' 'TOKEN_FROM_DM' > ~/.config/loylex/gitlab/token && chmod 600 ~/.config/loylex/gitlab/token
```

Check the modes with `stat -c '%a %n' ~/.config/loylex/gitlab/*`. Ask the operator for a
read-only token (`read_repository`) with an expiry date, and say so if they sent a broader one.
The export script refuses a token file that is readable by group or others.

## Export

```bash
OUT=$(mktemp -d /workspace/tmp/gitlab-export.XXXXXX)
python3 -I /workspace/Loylex/skills/gitlab-repo-zip/export_repo.py "$OUT"
```

It prints a JSON report with `zip`, `bytes`, `head`, `branches`, `lfs`, and `secret_findings`.

- Exit 1 with `refusing to deliver` means the token itself is inside the repository. Deliver
  nothing. Tell the operator the file path only.
- Exit 1 with `above Telegram's 50 MiB` means the zip is too big for a bot document. Report the
  size and offer options such as a split archive or a `git bundle`. Wait for a choice. Do not
  change the content silently.
- `lfs: true` means Git LFS objects are not in the zip. Say so.
- `secret_findings` lists paths and rule names, never values. If it is not empty, show the list
  and wait for the operator's go-ahead before uploading anywhere.

## Deliver

```bash
loylex upload CHAT_ID "$ZIP" "CAPTION"
```

Use the chat the operator names. A first test goes to the operator's DM (426043802). Wait for
exit code 0 and do not upload the same zip twice. Then remove the exact directory you created:
`rm -rf "$OUT"`.

## Rules

- The token must never appear in a remote URL, argv, the zip, `.git/config`, Git history,
  memory, or chat. The script passes it only through `GIT_CONFIG_*` environment variables.
- Do not post the zip to a group chat unless the operator asks for that chat.
- Tests: `python3 -B -m unittest discover tests -p 'gitlab_repo_zip_test.py'`.
