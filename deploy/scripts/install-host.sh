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
versions_file="$deploy_root/host/versions.env"

if [[ ! -r "$versions_file" ]]; then
  echo "Missing host dependency pins: $versions_file" >&2
  exit 1
fi

read_pin() {
  local key="$1"
  local value
  value="$(awk -F= -v key="$key" '
    /^[[:space:]]*(#|$)/ { next }
    $1 == key { count++; value=substr($0, index($0, "=") + 1) }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "$versions_file")" || {
    echo "Invalid or duplicate host dependency pin: $key" >&2
    exit 1
  }
  if [[ -z "$value" || "$value" == *$'\n'* ]]; then
    echo "Empty host dependency pin: $key" >&2
    exit 1
  fi
  printf '%s' "$value"
}

pm3_version="$(read_pin PM3_VERSION)"
pm3_release="$(read_pin PM3_RELEASE)"
pm3_evr="$(read_pin PM3_EVR)"
pm3_upstream_commit="$(read_pin PM3_UPSTREAM_COMMIT)"
pm3_upstream_url="$(read_pin PM3_UPSTREAM_RPM_URL)"
pm3_upstream_sha256="$(read_pin PM3_UPSTREAM_RPM_SHA256)"
pm3_copr_owner="$(read_pin PM3_COPR_OWNER)"
pm3_copr_project="$(read_pin PM3_COPR_PROJECT)"

if [[ ! "$pm3_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$pm3_release" =~ ^[0-9]+$ || "$pm3_evr" != "$pm3_version-$pm3_release" ]]; then
  echo "Inconsistent PM3 version pins in $versions_file" >&2
  exit 1
fi
if [[ ! "$pm3_upstream_commit" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Invalid PM3 upstream commit pin" >&2
  exit 1
fi
if [[ ! "$pm3_copr_owner" =~ ^[a-z0-9_-]+$ || ! "$pm3_copr_project" =~ ^[a-z0-9_-]+$ ]]; then
  echo "Invalid PM3 COPR pin" >&2
  exit 1
fi
if [[ ! "$pm3_upstream_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Invalid PM3 upstream SHA-256 pin" >&2
  exit 1
fi
expected_upstream_url="https://github.com/ExposedCat/pm3/releases/download/v${pm3_version}/pm3-${pm3_evr}.x86_64.rpm"
if [[ "$pm3_upstream_url" != "$expected_upstream_url" ]]; then
  echo "PM3 upstream URL does not match the pinned release" >&2
  exit 1
fi

# Fedora 44 uses DNF5; Rocky's supported installation may use either DNF5 or
# the DNF4 plugin. Install the matching plugin before touching stack packages.
dnf_cmd=(dnf)
dnf_plugins_package=python3-dnf-plugin-versionlock
if command -v dnf5 >/dev/null 2>&1; then
  dnf_cmd=(dnf5)
  dnf_plugins_package=dnf5-plugins
fi
"${dnf_cmd[@]}" install -y "$dnf_plugins_package"

versionlock_cmd=()
if "${dnf_cmd[@]}" versionlock --help >/dev/null 2>&1; then
  versionlock_cmd=("${dnf_cmd[@]}")
else
  echo "The DNF versionlock plugin is required for pinned stack packages" >&2
  exit 1
fi

# Running this installer is the explicit PM3 update action. Keep the runtime
# package locks in place: an update of Podman or podman-compose needs its own
# review and must not happen as a side effect of a PM3 update.
"${versionlock_cmd[@]}" versionlock delete pm3 >/dev/null 2>&1 || true

# PM3 is installed on the host, where it can manage rootless Podman; the agent
# container deliberately has no Podman socket or host systemd bus. Fedora uses
# the maintainer's COPR, but downloads the exact build recorded in versions.env.
# Rocky has no matching COPR chroot, so it uses the exact upstream RPM instead.
if [[ -f /etc/rocky-release ]]; then
  "${dnf_cmd[@]}" install -y epel-release
fi
"${dnf_cmd[@]}" install -y \
  curl \
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
  fedora_release="$(awk -F= '$1 == "VERSION_ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)"
  case "$fedora_release" in
    43|44)
      pm3_rpm_url="$(read_pin "PM3_COPR_FEDORA_${fedora_release}_RPM_URL")"
      pm3_rpm_sha256="$(read_pin "PM3_COPR_FEDORA_${fedora_release}_RPM_SHA256")"
      expected_copr_url="https://download.copr.fedorainfracloud.org/results/${pm3_copr_owner}/${pm3_copr_project}/fedora-${fedora_release}-x86_64/Packages/p/pm3-${pm3_evr}.x86_64.rpm"
      if [[ "$pm3_rpm_url" != "$expected_copr_url" ]]; then
        echo "PM3 COPR URL does not match Fedora $fedora_release pin" >&2
        exit 1
      fi
      ;;
    *)
      echo "No reviewed PM3 COPR pin for Fedora $fedora_release" >&2
      exit 1
      ;;
  esac
  "${dnf_cmd[@]}" copr enable -y "$pm3_copr_owner/$pm3_copr_project"
else
  pm3_rpm_url="$pm3_upstream_url"
  pm3_rpm_sha256="$pm3_upstream_sha256"
fi

if [[ ! "$pm3_rpm_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Invalid PM3 RPM SHA-256 pin" >&2
  exit 1
fi
pm3_rpm_file="$(mktemp /tmp/loylex-pm3.XXXXXX.rpm)"
trap 'rm -f -- "$pm3_rpm_file"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
  -o "$pm3_rpm_file" "$pm3_rpm_url"
printf '%s  %s\n' "$pm3_rpm_sha256" "$pm3_rpm_file" | sha256sum -c -
pm3_rpm_name="$(rpm -qp --qf '%{NAME}' "$pm3_rpm_file")"
pm3_rpm_version="$(rpm -qp --qf '%{VERSION}' "$pm3_rpm_file")"
pm3_rpm_release="$(rpm -qp --qf '%{RELEASE}' "$pm3_rpm_file")"
pm3_rpm_arch="$(rpm -qp --qf '%{ARCH}' "$pm3_rpm_file")"
if [[ "$pm3_rpm_name" != pm3 || "$pm3_rpm_version-$pm3_rpm_release" != "$pm3_evr" || "$pm3_rpm_arch" != x86_64 ]]; then
  echo "Downloaded PM3 RPM metadata does not match the pin" >&2
  exit 1
fi
"${dnf_cmd[@]}" install -y "$pm3_rpm_file"
rm -f -- "$pm3_rpm_file"
trap - EXIT
installed_pm3_evr="$(rpm -q --qf '%{VERSION}-%{RELEASE}' pm3)"
if [[ "$installed_pm3_evr" != "$pm3_evr" ]]; then
  echo "Installed PM3 version $installed_pm3_evr does not match $pm3_evr" >&2
  exit 1
fi
if ! rpm -V pm3; then
  echo "Installed PM3 RPM failed rpm verification" >&2
  exit 1
fi

# PM3 and the two runtime packages it drives are only changed by an explicit
# reviewed installer run. DNF still receives normal updates for the rest of
# the host, while these three package versions remain stable. Do not add a
# duplicate entry when the runtime package was already locked by an earlier
# install; preserving that entry is what prevents an incidental PM3 update
# from changing the runtime underneath it.
versionlock_entries="$("${versionlock_cmd[@]}" versionlock list 2>/dev/null || true)"
for stack_package in pm3 podman podman-compose; do
  if ! grep -Eq "(^|[[:space:]:])${stack_package}-" <<<"$versionlock_entries"; then
    "${versionlock_cmd[@]}" versionlock add "$stack_package"
  fi
done

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
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
    sh -c 'cd "$HOME" && exec "$@"' sh "$@"
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
  as_loylex systemd-run --user --wait --collect --quiet \
    --property=KillMode=process \
    --setenv=HOME=/home/loylex \
    --setenv=XDG_RUNTIME_DIR="$runtime_directory" \
    --setenv=XDG_DATA_HOME=/home/loylex/.local/share \
    --setenv=DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_directory/bus" \
    pm3 "$@"
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
