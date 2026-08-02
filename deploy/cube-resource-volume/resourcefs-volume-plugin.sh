#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${RESOURCEFS_VOLUME_CONFIG:-/etc/cubesandbox/resourcefs-volume.conf}"
OP=""
VOLUME_ID=""
NAME=""
REF_COUNT="0"
VOLUME_BASE_DIR=""

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op) need_value "$@"; OP="$2"; shift 2 ;;
    --volume-id) need_value "$@"; VOLUME_ID="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --ref-count) need_value "$@"; REF_COUNT="$2"; shift 2 ;;
    --volume-base-dir) need_value "$@"; VOLUME_BASE_DIR="$2"; shift 2 ;;
    --sandbox-id|--namespace|--private-data|--metadata) need_value "$@"; shift 2 ;;
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
    [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || fail
    [[ "$(stat -c %u "$CONFIG_FILE")" == "0" ]] || fail
    config_mode="$(stat -c %a "$CONFIG_FILE")"
    [[ "$config_mode" =~ ^[0-7]{3,4}$ && "${config_mode: -2}" == "00" ]] || fail
    # 配置文件由部署方以 root:root 0600 提供；它是插件唯一的秘密输入边界。
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
    : "${RESOURCE_FILESYSTEM_ENDPOINT:?}"
    : "${RESOURCE_FILESYSTEM_SIGNING_KEY:?}"
    : "${RESOURCEFS_RCLONE_BIN:=/usr/bin/rclone}"
    [[ "$RESOURCE_FILESYSTEM_ENDPOINT" =~ ^https://[^[:space:]?#]+/v1/resource-filesystem/?$ ]] || fail
    [[ ${#RESOURCE_FILESYSTEM_SIGNING_KEY} -ge 32 && ${#RESOURCE_FILESYSTEM_SIGNING_KEY} -le 256 ]] || fail
    [[ -x "$RESOURCEFS_RCLONE_BIN" ]] || fail
    command -v openssl >/dev/null || fail
    command -v base64 >/dev/null || fail
    command -v mountpoint >/dev/null || fail
    command -v fusermount3 >/dev/null || fail

    volume_root="${VOLUME_BASE_DIR%/}/runtime-resourcefs-${VOLUME_ID}"
    cache_base="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-cache"
    cache_root="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-cache/${VOLUME_ID}"
    log_base="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-log"
    log_root="${VOLUME_BASE_DIR%/}/.runtime-resourcefs-log/${VOLUME_ID}"
    ensure_directory "$VOLUME_BASE_DIR"
    ensure_directory "$volume_root"
    ensure_directory "$cache_base"
    ensure_directory "$cache_root"
    ensure_directory "$log_base"
    ensure_directory "$log_root"

    if ! mountpoint -q "$volume_root"; then
      capability_body="$(printf '{"v":2,"tenantId":"%s"}' "$VOLUME_ID" | base64 | tr -d '\n=' | tr '+/' '-_')"
      capability_signature="$(printf '%s' "$capability_body" | openssl dgst -sha256 -hmac "$RESOURCE_FILESYSTEM_SIGNING_KEY" -binary | base64 | tr -d '\n=' | tr '+/' '-_')"
      capability="${capability_body}.${capability_signature}"
      endpoint="${RESOURCE_FILESYSTEM_ENDPOINT%/}"
      env \
        RCLONE_CONFIG_RESOURCEFS_TYPE=webdav \
        RCLONE_CONFIG_RESOURCEFS_URL="$endpoint" \
        RCLONE_CONFIG_RESOURCEFS_VENDOR=other \
        RCLONE_CONFIG_RESOURCEFS_BEARER_TOKEN="$capability" \
        "$RESOURCEFS_RCLONE_BIN" mount resourcefs: "$volume_root" \
          --read-only \
          --allow-other \
          --daemon \
          --daemon-timeout 20s \
          --dir-cache-time 30s \
          --poll-interval 0 \
          --vfs-cache-mode full \
          --vfs-cache-max-size 2G \
          --vfs-cache-max-age 24h \
          --cache-dir "$cache_root" \
          --log-file "$log_root/rclone.log" \
          --log-level NOTICE \
          --dir-perms 0555 \
          --file-perms 0444
      for _ready in {1..40}; do
        mountpoint -q "$volume_root" && break
        sleep 0.25
      done
      mountpoint -q "$volume_root" || fail
    fi
    printf '{"host_path":"%s","metadata":{"mount_dir":"%s"},"error":""}\n' "$volume_root" "$volume_root"
    ;;
  detach)
    [[ "$VOLUME_BASE_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail
    volume_root="${VOLUME_BASE_DIR%/}/runtime-resourcefs-${VOLUME_ID}"
    if [[ "$REF_COUNT" == "0" ]] && mountpoint -q "$volume_root"; then
      fusermount3 -uz "$volume_root" || fail
      for _detached in {1..40}; do
        mountpoint -q "$volume_root" || break
        sleep 0.25
      done
      mountpoint -q "$volume_root" && fail
    fi
    printf '{"error":""}\n'
    ;;
  *) fail ;;
esac
