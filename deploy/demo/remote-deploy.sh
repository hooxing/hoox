#!/usr/bin/env bash
set -Eeuo pipefail

root="${HOOX_DEMO_ROOT:-/opt/hoox-demo}"
release_id="${RELEASE_ID:?RELEASE_ID is required}"
image="${HOOX_DEMO_IMAGE:?HOOX_DEMO_IMAGE is required}"
domain="${HOOX_DEMO_DOMAIN:-hoox.aisay.cc}"
bucket="${HOOX_DEMO_BUCKET:-agent-runtime-demo}"
release_dir="$root/releases/$release_id"
shared_dir="$root/shared"
compose_file="$release_dir/docker-compose.yml"
compose_env="$shared_dir/compose.env"
previous_release=""
previous_image=""
temporary_files=()
nginx_configuration_touched=false
nginx_previous_configuration=""
nginx_bootstrap_configuration=""

if [[ ! -f "$compose_file" || ! -f "$release_dir/postgres-init.sh" ]]; then
  echo "Demo 发布包不完整" >&2
  exit 2
fi
for file in infra.env migration.env api.env scheduler.env worker.env demo-account.env; do
  if [[ ! -f "$shared_dir/$file" ]]; then
    echo "Demo 服务器缺少共享配置：$file" >&2
    exit 2
  fi
done
if [[ -L "$root/current" ]]; then
  previous_release="$(readlink -f "$root/current")"
fi
if [[ -f "$compose_env" ]]; then
  previous_image="$(sed -n 's/^HOOX_DEMO_IMAGE=//p' "$compose_env" | tail -n 1)"
fi

write_compose_env() {
  local target_image="$1"
  local tenant_id="${2:-}"
  local temporary="$compose_env.tmp"
  umask 077
  {
    printf 'HOOX_DEMO_IMAGE=%s\n' "$target_image"
    printf 'HOOX_DEMO_ROOT=%s\n' "$root"
    printf 'HOOX_DEMO_RELEASE_DIR=%s\n' "$release_dir"
    if [[ -n "$tenant_id" ]]; then
      printf 'DEMO_TENANT_ID=%s\n' "$tenant_id"
    fi
  } >"$temporary"
  mv -f "$temporary" "$compose_env"
}

existing_tenant=""
if [[ -f "$compose_env" ]]; then
  existing_tenant="$(sed -n 's/^DEMO_TENANT_ID=//p' "$compose_env" | tail -n 1)"
fi
write_compose_env "$image" "$existing_tenant"

compose() {
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" "$@"
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  local status=$?
  trap - ERR
  if [[ "$nginx_configuration_touched" == "true" ]]; then
    if [[ -n "$nginx_previous_configuration" && -f "$nginx_previous_configuration" ]]; then
      sudo install -m 0644 "$nginx_previous_configuration" /etc/nginx/conf.d/hoox-demo.conf
    else
      sudo rm -f /etc/nginx/conf.d/hoox-demo.conf
    fi
    if [[ -n "$nginx_bootstrap_configuration" && -f "$nginx_bootstrap_configuration" ]]; then
      sudo install -m 0644 "$nginx_bootstrap_configuration" /etc/nginx/conf.d/hoox-demo-bootstrap.conf
    fi
    sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
  fi
  if (( ${#temporary_files[@]} > 0 )); then
    rm -f -- "${temporary_files[@]}"
  fi
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" stop api web scheduler worker >/dev/null 2>&1 || true
  if [[ -n "$previous_release" && -f "$previous_release/docker-compose.yml" && -n "$previous_image" ]]; then
    release_dir="$previous_release"
    compose_file="$previous_release/docker-compose.yml"
    write_compose_env "$previous_image" "$existing_tenant"
    docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" up -d api web scheduler worker || true
    ln -sfn "$previous_release" "$root/current"
  fi
  echo "Hoox Demo 发布失败，已尝试恢复上一应用版本；数据库迁移不会自动回退" >&2
  exit "$status"
}
trap rollback ERR

compose pull api web scheduler worker migrate
compose up -d postgres minio
compose --profile ops run --rm minio-init
compose --profile ops run --rm migrate
compose up -d api web
wait_http "http://127.0.0.1:3001/live"
wait_http "http://127.0.0.1:4173/"

if ! sudo test -f "/etc/letsencrypt/live/$domain/fullchain.pem" || ! sudo test -f "/etc/letsencrypt/live/$domain/privkey.pem"; then
  echo "Demo TLS 证书尚未初始化" >&2
  exit 1
fi
nginx_candidate="$(mktemp)"
temporary_files+=("$nginx_candidate")
if [[ -f /etc/nginx/conf.d/hoox-demo.conf ]]; then
  nginx_previous_configuration="$(mktemp)"
  cp /etc/nginx/conf.d/hoox-demo.conf "$nginx_previous_configuration"
  temporary_files+=("$nginx_previous_configuration")
fi
if [[ -f /etc/nginx/conf.d/hoox-demo-bootstrap.conf ]]; then
  nginx_bootstrap_configuration="$(mktemp)"
  cp /etc/nginx/conf.d/hoox-demo-bootstrap.conf "$nginx_bootstrap_configuration"
  temporary_files+=("$nginx_bootstrap_configuration")
fi
sed -e "s/@@DOMAIN@@/$domain/g" -e "s/@@BUCKET@@/$bucket/g" \
  "$release_dir/nginx.conf.template" >"$nginx_candidate"
sudo install -m 0644 "$nginx_candidate" /etc/nginx/conf.d/hoox-demo.conf
nginx_configuration_touched=true
sudo nginx -t
sudo rm -f /etc/nginx/conf.d/hoox-demo-bootstrap.conf
sudo nginx -t
sudo systemctl reload nginx
wait_http "https://$domain/api/ready"

set -a
# shellcheck disable=SC1091
source "$shared_dir/infra.env"
# shellcheck disable=SC1091
source "$shared_dir/demo-account.env"
set +a

account_payload="$(python3 - <<'PY'
import json, os
print(json.dumps({
    "name": os.environ["DEMO_ACCOUNT_DISPLAY_NAME"],
    "email": os.environ["DEMO_ACCOUNT_EMAIL"],
    "password": os.environ["DEMO_ACCOUNT_PASSWORD"],
}, ensure_ascii=False))
PY
)"
cookie_jar="$(mktemp)"
account_response="$(mktemp)"
temporary_files+=("$cookie_jar" "$account_response")
signup_status="$(curl --silent --show-error --output "$account_response" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Origin: https://$domain" \
  --header "Referer: https://$domain/" \
  --cookie-jar "$cookie_jar" \
  --data "$account_payload" \
  "https://$domain/api/api/auth/sign-up/email")"
if [[ "$signup_status" != "200" && "$signup_status" != "201" && "$signup_status" != "409" && "$signup_status" != "422" ]]; then
  echo "Demo 账号注册失败" >&2
  exit 1
fi
signin_payload="$(python3 - <<'PY'
import json, os
print(json.dumps({
    "email": os.environ["DEMO_ACCOUNT_EMAIL"],
    "password": os.environ["DEMO_ACCOUNT_PASSWORD"],
}, ensure_ascii=False))
PY
)"
signin_status="$(curl --silent --show-error --output "$account_response" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Origin: https://$domain" \
  --header "Referer: https://$domain/" \
  --cookie "$cookie_jar" --cookie-jar "$cookie_jar" \
  --data "$signin_payload" \
  "https://$domain/api/api/auth/sign-in/email")"
if [[ "$signin_status" != "200" ]]; then
  echo "Demo 账号登录初始化失败" >&2
  exit 1
fi
exchange_status="$(curl --silent --show-error --output "$account_response" --write-out '%{http_code}' \
  --request POST --header "Origin: https://$domain" --cookie "$cookie_jar" \
  "https://$domain/api/v1/auth/exchange")"
rm -f "$cookie_jar" "$account_response"
if [[ "$exchange_status" != "200" ]]; then
  echo "Demo 账号 Session 交换失败" >&2
  exit 1
fi

tenant_id="$(printf '%s\n' \
  "SELECT personal_tenant_id FROM :\"runtime_schema\".user_accounts WHERE normalized_email=lower(:'demo_email') LIMIT 1;" \
  | compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set=runtime_schema="$DATABASE_SCHEMA" \
      --set=demo_email="$DEMO_ACCOUNT_EMAIL" \
      --tuples-only --no-align)"
if [[ ! "$tenant_id" =~ ^tenant_[a-zA-Z0-9_-]+$ ]]; then
  echo "Demo Tenant 初始化失败" >&2
  exit 1
fi
write_compose_env "$image" "$tenant_id"
compose up -d scheduler worker
sleep 10
for service in api web scheduler worker; do
  container_id="$(compose ps -q "$service")"
  if [[ -z "$container_id" || "$(docker inspect --format '{{.State.Running}}' "$container_id")" != "true" ]]; then
    echo "Demo 服务未保持运行：$service" >&2
    compose logs --no-color --tail 80 "$service" >&2 || true
    exit 1
  fi
done
wait_http "http://127.0.0.1:3001/ready"
wait_http "https://$domain/api/ready"

ln -sfn "$release_dir" "$root/current"
if (( ${#temporary_files[@]} > 0 )); then
  rm -f -- "${temporary_files[@]}"
fi
trap - ERR

find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk 'NR>5 {print $2}' \
  | while IFS= read -r old_release; do
      [[ "$old_release" == "$release_dir" || "$old_release" == "$previous_release" ]] || rm -rf -- "$old_release"
    done

echo "Hoox Demo 发布完成：$release_id"
