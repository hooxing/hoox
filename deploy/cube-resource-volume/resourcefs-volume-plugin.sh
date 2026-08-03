#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${RESOURCEFS_VOLUME_CONFIG:-/etc/cubesandbox/resourcefs-volume.conf}"
OP=""
VOLUME_ID=""
NAME=""
REF_COUNT="0"
VOLUME_BASE_DIR=""
METADATA=""

fail() {
  printf '{"error":"RESOURCEFS_VOLUME_PLUGIN_FAILED"}\n'
  exit 1
}

need_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail
}

ensure_directory() {
  [[ ! -L "$1" ]] || fail
  mkdir -p "$1"
  [[ -d "$1" && ! -L "$1" ]] || fail
}

probe_resourcefs_remote() {
  env \
    RCLONE_CONFIG_RESOURCEFS_TYPE=webdav \
    RCLONE_CONFIG_RESOURCEFS_URL="$endpoint" \
    RCLONE_CONFIG_RESOURCEFS_VENDOR=other \
    RCLONE_CONFIG_RESOURCEFS_BEARER_TOKEN="$capability" \
    "$RESOURCEFS_RCLONE_BIN" lsf resourcefs: \
      --max-depth 1 \
      --contimeout 5s \
      --timeout 10s \
      --retries 1 \
      --low-level-retries 1 \
      >/dev/null 2>&1
}

probe_resourcefs_mount() {
  timeout --signal=KILL 10s ls -A -- "$volume_root" >/dev/null 2>&1
}

unmount_resourcefs() {
  if mountpoint -q "$volume_root"; then
    fusermount3 -uz "$volume_root" || return 1
    for _detached in {1..40}; do
      mountpoint -q "$volume_root" || break
      sleep 0.25
    done
    mountpoint -q "$volume_root" && return 1
  fi
  stop_tracked_rclone
}

stop_tracked_rclone() {
  [[ -e "$pid_file" ]] || return 0
  [[ -f "$pid_file" && ! -L "$pid_file" ]] || return 1
  tracked_pid="$(<"$pid_file")"
  [[ "$tracked_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if kill -0 "$tracked_pid" 2>/dev/null; then
    [[ -r "/proc/${tracked_pid}/cmdline" ]] || return 1
    mapfile -d '' -t tracked_args < "/proc/${tracked_pid}/cmdline"
    [[
      "${tracked_args[0]-}" == "$RESOURCEFS_RCLONE_BIN" &&
      "${tracked_args[1]-}" == "mount" &&
      "${tracked_args[2]-}" == "resourcefs:" &&
      "${tracked_args[3]-}" == "$volume_root"
    ]] || return 1
    kill "$tracked_pid" 2>/dev/null || return 1
    for _stopped in {1..40}; do
      kill -0 "$tracked_pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$tracked_pid" 2>/dev/null; then
      kill -KILL "$tracked_pid" 2>/dev/null || return 1
    fi
  fi
  rm -f -- "$pid_file"
}

load_config() {
  [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || fail
  [[ "$(stat -c %u "$CONFIG_FILE")" == "0" ]] || fail
  config_mode="$(stat -c %a "$CONFIG_FILE")"
  [[ "$config_mode" =~ ^[0-7]{3,4}$ && "${config_mode: -2}" == "00" ]] || fail
  # 配置文件由部署方以 root:root 0600 提供；它是插件唯一的秘密输入边界。
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  : "${RESOURCEFS_VOLUME_BASE_DIR:=/data/cube-shared/volume}"
  : "${RESOURCEFS_RCLONE_BIN:=/usr/bin/rclone}"
  [[ "$RESOURCEFS_VOLUME_BASE_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail
  [[ "$RESOURCEFS_VOLUME_BASE_DIR" != *"/../"* && "$RESOURCEFS_VOLUME_BASE_DIR" != */.. ]] || fail
  RESOURCEFS_VOLUME_BASE_DIR="${RESOURCEFS_VOLUME_BASE_DIR%/}"
  [[ -n "$RESOURCEFS_VOLUME_BASE_DIR" ]] || fail
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op) need_value "$@"; OP="$2"; shift 2 ;;
    --volume-id) need_value "$@"; VOLUME_ID="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --ref-count) need_value "$@"; REF_COUNT="$2"; shift 2 ;;
    --volume-base-dir) need_value "$@"; VOLUME_BASE_DIR="$2"; shift 2 ;;
    --metadata) need_value "$@"; METADATA="$2"; shift 2 ;;
    --sandbox-id|--namespace|--private-data) need_value "$@"; shift 2 ;;
    *) fail ;;
  esac
done

[[ "$VOLUME_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || fail
[[ "$REF_COUNT" =~ ^[0-9]+$ ]] || fail

case "$OP" in
  create)
    [[ "$NAME" == "$VOLUME_ID" ]] || fail
    # Cube Volume 只是 Tenant ResourceFS 的长期视图选择器，Destroy 不得删除 PostgreSQL/MinIO 数据。
    printf '{"token":"","private_data":"","error":""}\n'
    ;;
  destroy)
    printf '{"error":""}\n'
    ;;
  attach)
    [[ "$VOLUME_BASE_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail
    [[ "$VOLUME_BASE_DIR" != *"/../"* && "$VOLUME_BASE_DIR" != */.. ]] || fail
    load_config
    [[ "${VOLUME_BASE_DIR%/}" == "$RESOURCEFS_VOLUME_BASE_DIR" ]] || fail
    : "${RESOURCE_FILESYSTEM_ENDPOINT:?}"
    : "${RESOURCE_FILESYSTEM_SIGNING_KEY:?}"
    [[ "$RESOURCE_FILESYSTEM_ENDPOINT" =~ ^https://[^[:space:]?#]+/v1/resource-filesystem/?$ ]] || fail
    [[ ${#RESOURCE_FILESYSTEM_SIGNING_KEY} -ge 32 && ${#RESOURCE_FILESYSTEM_SIGNING_KEY} -le 256 ]] || fail
    [[ -x "$RESOURCEFS_RCLONE_BIN" ]] || fail
    command -v openssl >/dev/null || fail
    command -v base64 >/dev/null || fail
    command -v mountpoint >/dev/null || fail
    command -v fusermount3 >/dev/null || fail
    command -v timeout >/dev/null || fail

    volume_root="${VOLUME_BASE_DIR%/}/runtime-resourcefs-${VOLUME_ID}"
    cache_base="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-cache"
    cache_root="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-cache/${VOLUME_ID}"
    log_base="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-log"
    log_root="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-log/${VOLUME_ID}"
    pid_file="${log_root}/rclone.pid"
    ensure_directory "$VOLUME_BASE_DIR"
    ensure_directory "$volume_root"
    ensure_directory "$cache_base"
    ensure_directory "$cache_root"
    ensure_directory "$log_base"
    ensure_directory "$log_root"

    capability_body="$(printf '{"v":2,"tenantId":"%s"}' "$VOLUME_ID" | base64 | tr -d '\n=' | tr '+/' '-_')"
    capability_signature="$(printf '%s' "$capability_body" | openssl dgst -sha256 -hmac "$RESOURCE_FILESYSTEM_SIGNING_KEY" -binary | base64 | tr -d '\n=' | tr '+/' '-_')"
    capability="${capability_body}.${capability_signature}"
    endpoint="${RESOURCE_FILESYSTEM_ENDPOINT%/}"

    # mountpoint 只能证明内核里仍有 FUSE 条目，不能证明 rclone/WebDAV 数据面可用。
    # 先用同一 capability 直探远端；否则坏挂载会被复用并让 Sandbox 内 open(2) 无界阻塞。
    probe_resourcefs_remote || fail
    if mountpoint -q "$volume_root" && ! probe_resourcefs_mount; then
      # refCount=1 表示本次 Attach 之前没有使用者，此时才允许修复残留挂载。
      [[ "$REF_COUNT" == "1" ]] || fail
      unmount_resourcefs || fail
    fi

    if ! mountpoint -q "$volume_root"; then
      # 上一次 lazy unmount 后若 rclone 没有自行退出，先按受信 PID 文件精确回收。
      stop_tracked_rclone || fail
      env \
        RCLONE_CONFIG_RESOURCEFS_TYPE=webdav \
        RCLONE_CONFIG_RESOURCEFS_URL="$endpoint" \
        RCLONE_CONFIG_RESOURCEFS_VENDOR=other \
        RCLONE_CONFIG_RESOURCEFS_BEARER_TOKEN="$capability" \
        "$RESOURCEFS_RCLONE_BIN" mount resourcefs: "$volume_root" \
          --read-only \
          --allow-other \
          --dir-cache-time 30s \
          --poll-interval 0 \
          --vfs-cache-mode full \
          --vfs-cache-max-size 2G \
          --vfs-cache-max-age 24h \
          --cache-dir "$cache_root" \
          --log-file "$log_root/rclone.log" \
          --log-level NOTICE \
          --dir-perms 0555 \
          --file-perms 0444 \
          </dev/null >/dev/null 2>&1 &
      mount_pid="$!"
      pid_tmp="${pid_file}.tmp.$$"
      (umask 077 && printf '%s\n' "$mount_pid" > "$pid_tmp") || {
        kill "$mount_pid" 2>/dev/null || true
        wait "$mount_pid" 2>/dev/null || true
        fail
      }
      mv -f -- "$pid_tmp" "$pid_file" || {
        kill "$mount_pid" 2>/dev/null || true
        wait "$mount_pid" 2>/dev/null || true
        fail
      }
      for _ready in {1..40}; do
        mountpoint -q "$volume_root" && break
        if ! kill -0 "$mount_pid" 2>/dev/null; then
          wait "$mount_pid" 2>/dev/null || true
          fail
        fi
        sleep 0.25
      done
      if ! mountpoint -q "$volume_root"; then
        kill "$mount_pid" 2>/dev/null || true
        wait "$mount_pid" 2>/dev/null || true
        fail
      fi
      if ! probe_resourcefs_mount; then
        unmount_resourcefs || true
        kill "$mount_pid" 2>/dev/null || true
        wait "$mount_pid" 2>/dev/null || true
        fail
      fi
    fi
    printf '{"host_path":"%s","metadata":{"mount_dir":"%s"},"error":""}\n' "$volume_root" "$volume_root"
    ;;
  detach)
    load_config
    command -v mountpoint >/dev/null || fail
    command -v fusermount3 >/dev/null || fail
    volume_root="${RESOURCEFS_VOLUME_BASE_DIR}/runtime-resourcefs-${VOLUME_ID}"
    log_root="${RESOURCEFS_VOLUME_BASE_DIR}/.runtime-resourcefs-log/${VOLUME_ID}"
    pid_file="${log_root}/rclone.pid"
    expected_metadata="$(printf '{\"mount_dir\":\"%s\"}' "$volume_root")"
    [[ "$METADATA" == "$expected_metadata" ]] || fail
    if [[ "$REF_COUNT" == "0" ]]; then
      unmount_resourcefs || fail
    fi
    printf '{"error":""}\n'
    ;;
  *) fail ;;
esac
