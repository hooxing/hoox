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
for file in infra.env migration.env api.env admin-control.env scheduler.env worker.env demo-account.env; do
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
  local admin_user_id="${3:-}"
  local temporary="$compose_env.tmp"
  umask 077
  {
    printf 'HOOX_DEMO_IMAGE=%s\n' "$target_image"
    printf 'HOOX_DEMO_ROOT=%s\n' "$root"
    printf 'HOOX_DEMO_RELEASE_DIR=%s\n' "$release_dir"
    if [[ -n "$tenant_id" ]]; then
      printf 'DEMO_TENANT_ID=%s\n' "$tenant_id"
    fi
    if [[ -n "$admin_user_id" ]]; then
      printf 'DEMO_ADMIN_USER_ID=%s\n' "$admin_user_id"
    fi
  } >"$temporary"
  mv -f "$temporary" "$compose_env"
}

existing_tenant=""
existing_admin_user=""
if [[ -f "$compose_env" ]]; then
  existing_tenant="$(sed -n 's/^DEMO_TENANT_ID=//p' "$compose_env" | tail -n 1)"
  existing_admin_user="$(sed -n 's/^DEMO_ADMIN_USER_ID=//p' "$compose_env" | tail -n 1)"
fi
write_compose_env "$image" "$existing_tenant" "$existing_admin_user"

compose() {
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" "$@"
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local netrc_file="${3:-}"
  local curl_options=(--fail --silent --show-error --max-time 5)
  if [[ -n "$netrc_file" ]]; then
    curl_options+=(--basic --netrc-file "$netrc_file")
  fi
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl "${curl_options[@]}" "$url" >/dev/null; then
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
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" \
    stop admin-control admin-web >/dev/null 2>&1 || true
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" \
    stop api web scheduler worker >/dev/null 2>&1 || true
  if [[ -n "$previous_release" && -f "$previous_release/docker-compose.yml" && -n "$previous_image" ]]; then
    release_dir="$previous_release"
    compose_file="$previous_release/docker-compose.yml"
    write_compose_env "$previous_image" "$existing_tenant" "$existing_admin_user"
    local -a restore_services=(api web scheduler worker)
    if docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" \
      config --services | grep -qx 'admin-control'; then
      restore_services+=(admin-control admin-web)
    fi
    docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" \
      up -d --force-recreate "${restore_services[@]}" || true
    ln -sfn "$previous_release" "$root/current"
  fi
  echo "Hoox Demo 发布失败，已尝试恢复上一应用版本；数据库迁移不会自动回退" >&2
  exit "$status"
}
trap rollback ERR

compose pull api web admin-control admin-web scheduler worker migrate
compose up -d postgres minio
compose --profile ops run --rm minio-init
compose --profile ops run --rm migrate
compose up -d api web
wait_http "http://127.0.0.1:3001/live"
wait_http "http://127.0.0.1:4173/"

set -a
# shellcheck disable=SC1091
source "$shared_dir/infra.env"
DEV_ADMIN_CONTROL_TOKEN="$(sed -n 's/^DEV_ADMIN_CONTROL_TOKEN=//p' "$shared_dir/admin-control.env" | tail -n 1)"
# shellcheck disable=SC1091
source "$shared_dir/demo-account.env"
set +a
if [[ ! "$DEV_ADMIN_CONTROL_TOKEN" =~ ^[A-Za-z0-9._~-]{32,512}$ ]]; then
  echo "Demo Admin Control Token 格式无效" >&2
  exit 1
fi
if [[ ! "$DEMO_ACCOUNT_EMAIL" =~ ^[^:[:space:]]+@[^:[:space:]]+$ ]]; then
  echo "Demo 管理账号不适合作为 HTTP Basic 用户名" >&2
  exit 1
fi
if [[ ! "$DEMO_ACCOUNT_PASSWORD" =~ ^[A-Za-z0-9._~-]{16,256}$ ]]; then
  echo "Demo 管理密码必须使用 URL 安全字符" >&2
  exit 1
fi

if ! sudo test -f "/etc/letsencrypt/live/$domain/fullchain.pem" || ! sudo test -f "/etc/letsencrypt/live/$domain/privkey.pem"; then
  echo "Demo TLS 证书尚未初始化" >&2
  exit 1
fi
nginx_candidate="$(mktemp)"
admin_htpasswd_candidate="$(mktemp)"
admin_token_candidate="$(mktemp)"
admin_netrc="$(mktemp)"
temporary_files+=("$nginx_candidate" "$admin_htpasswd_candidate" "$admin_token_candidate" "$admin_netrc")
chmod 0600 "$admin_netrc"
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
password_hash="$(printf '%s' "$DEMO_ACCOUNT_PASSWORD" | openssl passwd -apr1 -stdin)"
printf '%s:%s\n' "$DEMO_ACCOUNT_EMAIL" "$password_hash" >"$admin_htpasswd_candidate"
printf 'proxy_set_header Authorization "Bearer %s";\n' "$DEV_ADMIN_CONTROL_TOKEN" \
  >"$admin_token_candidate"
printf 'machine %s\nlogin %s\npassword %s\n' \
  "$domain" "$DEMO_ACCOUNT_EMAIL" "$DEMO_ACCOUNT_PASSWORD" >"$admin_netrc"
sudo install -o root -g www-data -m 0640 \
  "$admin_htpasswd_candidate" /etc/nginx/hoox-demo-admin.htpasswd
sudo install -o root -g root -m 0600 \
  "$admin_token_candidate" /etc/nginx/hoox-demo-admin-token.conf
sudo install -m 0644 "$nginx_candidate" /etc/nginx/conf.d/hoox-demo.conf
nginx_configuration_touched=true
sudo nginx -t
sudo rm -f /etc/nginx/conf.d/hoox-demo-bootstrap.conf
sudo nginx -t
sudo systemctl reload nginx
wait_http "https://$domain/api/ready"

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

account_record="$(printf '%s\n' \
  "SELECT user_id||'|'||personal_tenant_id FROM :\"runtime_schema\".user_accounts WHERE normalized_email=lower(:'demo_email') LIMIT 1;" \
  | compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set=runtime_schema="$DATABASE_SCHEMA" \
      --set=demo_email="$DEMO_ACCOUNT_EMAIL" \
      --tuples-only --no-align)"
IFS='|' read -r admin_user_id tenant_id <<<"$account_record"
if [[ ! "$tenant_id" =~ ^tenant_[a-zA-Z0-9_-]+$ || ! "$admin_user_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$ ]]; then
  echo "Demo Tenant 或管理员初始化失败" >&2
  exit 1
fi
printf '%s\n' \
  "INSERT INTO :\"runtime_schema\".platform_control_operators(user_id,role,status) VALUES(:'demo_user_id','admin','active') ON CONFLICT (user_id) DO UPDATE SET role='admin',status='active',updated_at=clock_timestamp(); INSERT INTO :\"runtime_schema\".platform_skill_operators(user_id,role,status) VALUES(:'demo_user_id','admin','active') ON CONFLICT (user_id) DO UPDATE SET role='admin',status='active',version_token=platform_skill_operators.version_token+1,updated_at=clock_timestamp();" \
  | compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set=runtime_schema="$DATABASE_SCHEMA" \
      --set=demo_user_id="$admin_user_id" \
      --quiet
write_compose_env "$image" "$tenant_id" "$admin_user_id"
compose up -d admin-control admin-web scheduler worker
wait_http "http://127.0.0.1:3003/live"
wait_http "http://127.0.0.1:4174/"
sleep 10
for service in api web admin-control admin-web scheduler worker; do
  container_id="$(compose ps -q "$service")"
  if [[ -z "$container_id" || "$(docker inspect --format '{{.State.Running}}' "$container_id")" != "true" ]]; then
    echo "Demo 服务未保持运行：$service" >&2
    compose logs --no-color --tail 80 "$service" >&2 || true
    exit 1
  fi
done
wait_http "http://127.0.0.1:3001/ready"
wait_http "http://127.0.0.1:3003/ready"
wait_http "https://$domain/api/ready"
wait_http "https://$domain/admin/" 60 "$admin_netrc"
wait_http "https://$domain/v1/admin/control/overview" 60 "$admin_netrc"

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
