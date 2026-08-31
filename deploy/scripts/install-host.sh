#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ "$#" -ne 2 ]]; then
  echo "Usage: install-host.sh TELEGRAM_TOKEN_FILE BRIDGE_TOKEN_FILE" >&2
  exit 1
fi

telegram_token_file="$(realpath "$1")"
bridge_token_file="$(realpath "$2")"
deploy_root="$(realpath "$(dirname "$0")/..")"

# PM3 is installed on the host, where it can manage rootless Podman; the agent
# container deliberately has no Podman socket or host systemd bus. Fedora uses
# the maintainer's COPR. Rocky has no matching COPR chroot, so use the same
# signed upstream RPM with its release checksum instead.
dnf install -y \
  curl \
  dnf-plugins-core \
  firewalld \
  fuse-overlayfs \
  git \
  jq \
  podman \
  podman-compose \
  shadow-utils \
  slirp4netns \
  sqlite \
  zstd
if [[ -f /etc/fedora-release ]]; then
  dnf copr enable -y exposedcat/pm3
  dnf install -y pm3
else
  pm3_version=3.2.3
  pm3_rpm_sha256=06ea475a4819888ba07b7556b1a772723540a5a5f251dc6e52f0f21466efb6ba
  pm3_rpm_url="https://github.com/ExposedCat/pm3/releases/download/v${pm3_version}/pm3-${pm3_version}-1.x86_64.rpm"
  pm3_rpm_file="$(mktemp /tmp/pm3.XXXXXX.rpm)"
  trap 'rm -f "$pm3_rpm_file"' EXIT
  curl -fsSL --retry 3 -o "$pm3_rpm_file" "$pm3_rpm_url"
  printf '%s  %s\n' "$pm3_rpm_sha256" "$pm3_rpm_file" | sha256sum -c -
  dnf install -y "$pm3_rpm_file"
  rm -f "$pm3_rpm_file"
  trap - EXIT
fi

if ! id loylex >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash loylex
  passwd --lock loylex
fi

loginctl enable-linger loylex
chown -R loylex:loylex /home/loylex
systemctl enable --now firewalld
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload

if [[ -z "$(swapon --show --noheadings)" && ! -e /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap defaults 0 0\n' >>/etc/fstab
fi

runtime_directory="/run/user/$(id -u loylex)"
install -d -m 0700 -o loylex -g loylex "$runtime_directory"
install -d -m 0700 -o loylex -g loylex /home/loylex/.config/loylex
install -d -m 0700 -o loylex -g loylex /home/loylex/.config/systemd/user
install -d -m 0700 -o loylex -g loylex /home/loylex/.local/bin
install -d -m 0700 -o loylex -g loylex /home/loylex/.local/share/pm3
install -d -m 0700 -o loylex -g loylex /home/loylex/.local/state/loylex-supervisor
install -d -m 0700 -o loylex -g loylex /home/loylex/backups/loylex
install -d -m 0700 -o loylex -g loylex /home/loylex/stack

state_file=/home/loylex/.local/state/loylex-supervisor/state.json
active_slot=blue
if [[ -r "$state_file" ]]; then
  saved_slot="$(jq -r '.activeAgentSlot // empty' "$state_file" 2>/dev/null || true)"
  if [[ "$saved_slot" == blue || "$saved_slot" == green ]]; then
    active_slot="$saved_slot"
  fi
fi
if [[ "$active_slot" == blue ]]; then
  inactive_slot=green
else
  inactive_slot=blue
fi

as_loylex() {
  runuser -u loylex -- env \
    HOME=/home/loylex \
    XDG_RUNTIME_DIR="$runtime_directory" \
    XDG_DATA_HOME=/home/loylex/.local/share \
    "$@"
}

# Stop the old supervisor and Quadlet units before reusing their exact
# container names. Named volumes are intentionally left in place.
as_loylex systemctl --user disable --now loylex-supervisor.service >/dev/null 2>&1 || true
for unit in \
  loylex-gateway.service \
  loylex-agent.service \
  loylex-agent-blue.service \
  loylex-agent-green.service; do
  as_loylex systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
done
for container in \
  loylex-gateway \
  loylex-agent \
  loylex-agent-blue \
  loylex-agent-green; do
  if as_loylex podman container exists "$container"; then
    as_loylex podman rm -f "$container"
  fi
done

install -m 0644 -o loylex -g loylex \
  "$deploy_root"/compose/compose.yaml \
  /home/loylex/stack/compose.yaml
install -m 0644 -o loylex -g loylex \
  "$deploy_root"/systemd/* \
  /home/loylex/.config/systemd/user/
install -m 0755 -o loylex -g loylex \
  "$deploy_root"/scripts/loylex-backup \
  /home/loylex/.local/bin/loylex-backup
install -m 0755 -o loylex -g loylex \
  "$deploy_root"/scripts/loylex-supervisor \
  /home/loylex/.local/bin/loylex-supervisor

supervisor_token_file=/home/loylex/.config/loylex/supervisor-token
if [[ ! -f "$supervisor_token_file" ]]; then
  umask 077
  head -c 48 /dev/urandom | base64 -w 0 >"$supervisor_token_file"
  printf '\n' >>"$supervisor_token_file"
fi
chown loylex:loylex "$supervisor_token_file"
chmod 0600 "$supervisor_token_file"

if ! as_loylex podman secret inspect loylex-telegram-token >/dev/null 2>&1; then
  as_loylex podman secret create loylex-telegram-token - <"$telegram_token_file"
fi
if ! as_loylex podman secret inspect loylex-bridge-token >/dev/null 2>&1; then
  as_loylex podman secret create loylex-bridge-token - <"$bridge_token_file"
fi
if ! as_loylex podman secret inspect loylex-supervisor-token >/dev/null 2>&1; then
  as_loylex podman secret create loylex-supervisor-token - <"$supervisor_token_file"
fi

for volume in \
  loylex-gateway-data \
  loylex-agent-home \
  loylex-memory \
  loylex-workspace; do
  if ! as_loylex podman volume inspect "$volume" >/dev/null 2>&1; then
    as_loylex podman volume create "$volume"
  fi
done
if ! as_loylex podman network exists loylex; then
  as_loylex podman network create loylex
fi

pm3_run() {
  as_loylex pm3 "$@"
}

pm3_database=/home/loylex/.local/share/pm3/pm3.sqlite
pm3_project_exists() {
  [[ -f "$pm3_database" ]] || return 1
  [[ "$(as_loylex sqlite3 "$pm3_database" \
    "SELECT 1 FROM projects WHERE name = '$1' LIMIT 1;")" == 1 ]]
}

create_pm3_project() {
  local name="$1"
  local profile="$2"
  if ! pm3_project_exists "$name"; then
    pm3_run create /home/loylex/stack --name "$name" --local -- \
      -p "$name" --profile "$profile"
  fi
}

create_pm3_project loylex-gateway gateway
create_pm3_project loylex-worker-blue blue
create_pm3_project loylex-worker-green green

as_loylex systemctl --user daemon-reload
as_loylex systemctl --user disable --now podman-auto-update.timer >/dev/null 2>&1 || true
as_loylex systemctl --user enable loylex-backup.timer loylex-supervisor.service pm3.service
as_loylex systemctl --user start loylex-backup.timer pm3.service

# Only one worker generation is enabled. The inactive registration remains in
# PM3 so the authenticated supervisor can roll into it without recreating the
# project definition.
pm3_run disable "loylex-worker-$inactive_slot" --now >/dev/null 2>&1 || true
pm3_run enable loylex-gateway --now
pm3_run enable "loylex-worker-$active_slot" --now
as_loylex podman update --memory-swap 13g "loylex-agent-$active_slot"
as_loylex systemctl --user start loylex-supervisor.service
