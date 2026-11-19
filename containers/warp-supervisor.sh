#!/usr/bin/env bash
set -euo pipefail

pid_path="${LOYLEX_WARP_PID_FILE:-/tmp/loylex-warp-svc.pid}"
log_path="${LOYLEX_WARP_LOG_FILE:-${HOME:-/home/loylex}/.local/state/loylex/warp/loylex-warp.log}"
log_archive_dir="$(dirname -- "$log_path")/archive"
log_max_bytes="${LOYLEX_WARP_LOG_MAX_BYTES:-67108864}"
log_check_seconds="${LOYLEX_WARP_LOG_CHECK_SECONDS:-600}"
proxy_port="${LOYLEX_WARP_PROXY_PORT:-40000}"
service_path=/bin/warp-svc
cli_path=/bin/warp-cli
child_pid=""
rotate_pid=""
stopping=0

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log_path"
}

cli() {
  sudo -n "$cli_path" --accept-tos "$@"
}

write_pid() {
  printf '%s\n' "$child_pid" >"$pid_path"
}

clear_pid() {
  if [[ -f "$pid_path" ]] && [[ "$(cat "$pid_path" 2>/dev/null || true)" == "$child_pid" ]]; then
    rm -f "$pid_path"
  fi
}

child_is_alive() {
  [[ -n "$child_pid" ]] && sudo -n kill -0 "$child_pid" 2>/dev/null
}

stop_child() {
  if ! child_is_alive; then
    return 0
  fi
  sudo -n kill -TERM "$child_pid" 2>/dev/null || true
  for _ in {1..30}; do
    child_is_alive || return 0
    sleep 1
  done
  sudo -n kill -KILL "$child_pid" 2>/dev/null || true
}

prepare_directories() {
  mkdir -p -m 0700 -- "$(dirname -- "$log_path")" \
    && sudo -n install -d -m 0700 /var/lib/cloudflare-warp /var/log/cloudflare-warp
}

start_child() {
  sudo -n "$service_path" >>"$log_path" 2>&1 &
  child_pid=$!
  write_pid
  log "started warp-svc pid=$child_pid"
}

wait_for_cli() {
  for _ in {1..120}; do
    child_is_alive || return 1
    if cli status >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

configure_until_ready() {
  while child_is_alive && ((stopping == 0)); do
    if wait_for_cli; then
      if ! cli registration show >/dev/null 2>&1; then
        log "registering a new consumer WARP device"
        cli registration new >>"$log_path" 2>&1 || true
      fi
      if cli mode proxy >>"$log_path" 2>&1 \
        && cli proxy port "$proxy_port" >>"$log_path" 2>&1 \
        && cli connect >>"$log_path" 2>&1; then
        log "WARP proxy configured on 127.0.0.1:$proxy_port"
        return 0
      fi
      log "WARP configuration is not ready; retrying"
    else
      log "warp-cli is not ready; retrying"
    fi
    sleep 5
  done
  return 1
}

on_signal() {
  stopping=1
  stop_child
}

# Copy the bytes written so far into a gzip archive, verify the copy, then empty the live file
# in place. warp-svc appends through its inherited O_APPEND descriptor, so it continues from
# offset 0. Writes that land between the copy and the truncate are lost (a few milliseconds).
rotate_log() {
  local size archive
  size="$(stat -c %s -- "$log_path" 2>/dev/null || echo 0)"
  if ((size <= log_max_bytes)); then
    return 0
  fi
  mkdir -p -m 0700 -- "$log_archive_dir" || return 1
  archive="$log_archive_dir/loylex-warp-$(date -u +%Y%m%dT%H%M%SZ).log.gz"
  { head -c "$size" -- "$log_path"; tail -c +"$((size + 1))" -- "$log_path"; } \
    | gzip -9 >"$archive.partial" || return 1
  if ! gzip -t -- "$archive.partial" \
    || ! cmp -s -- <(gzip -dc -- "$archive.partial" | head -c "$size") <(head -c "$size" -- "$log_path"); then
    rm -f -- "$archive.partial"
    return 1
  fi
  mv -f -- "$archive.partial" "$archive" || return 1
  : >"$log_path" || return 1
  log "rotated WARP log to $archive"
}

rotate_loop() {
  while sleep "$log_check_seconds"; do
    rotate_log || log "WARP log rotation failed; the live log was left in place"
  done
}

cleanup() {
  clear_pid
  if [[ -n "$rotate_pid" ]]; then
    kill "$rotate_pid" 2>/dev/null || true
  fi
}

if [[ "${1:-}" == rotate-log ]]; then
  rotate_log
  exit
fi

trap on_signal INT TERM
trap cleanup EXIT

until prepare_directories; do
  log "WARP state directories are not writable; retrying"
  sleep 5
done
(
  trap - EXIT INT TERM
  rotate_loop
) &
rotate_pid=$!
while ((stopping == 0)); do
  start_child
  configure_until_ready || true
  if wait "$child_pid"; then
    exit_status=0
  else
    exit_status=$?
  fi
  clear_pid
  child_pid=""
  ((stopping == 1)) && break
  log "warp-svc exited with status $exit_status; restarting in 2s"
  sleep 2
done
