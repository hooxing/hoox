#!/usr/bin/env bash
set -euo pipefail

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

shared_value() {
  sed -n "s/^$2=//p" "$shared_dir/$1" | tail -n 1
}

# 目录读取与 Webhook 投递使用独立凭据。部署前跨文件校对，不将密码或 DSN 写入日志。
verify_scheduler_database() {
  local LC_ALL=C role_key="DATABASE_${1}_ROLE" password_key="DATABASE_${1}_PASSWORD" url_key="$2"
  local role scheduler_url encoded decoded database
  database="$(shared_value infra.env POSTGRES_DB)"
  role="$(shared_value infra.env "$role_key")"
  if [[ ! "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    [[ -z "$(shared_value infra.env "$password_key")" ]]; then
    echo "Demo infra.env 缺少有效的 $1 数据库角色或密码" >&2
    return 1
  fi
  if [[ "$(shared_value migration.env "$role_key")" != "$role" ]]; then
    echo "Demo migration.env 的 $1 角色与 infra.env 不一致" >&2
    return 1
  fi
  scheduler_url="$(shared_value scheduler.env "$url_key")"
  if [[ "$(shared_value scheduler.env "$role_key")" != "$role" ]] ||
    [[ ! "$scheduler_url" =~ ^postgres(ql)?://([^:@/]+):([^@/?#]+)@127\.0\.0\.1:15432/([^/?#]+)$ ]] ||
    [[ "${BASH_REMATCH[2]}" != "$role" || "${BASH_REMATCH[4]}" != "$database" ]]; then
    echo "Demo scheduler.env 的 $1 角色或连接与 infra.env 不一致" >&2
    return 1
  fi
  encoded="${BASH_REMATCH[3]}"
  # 按 URL 百分号编码比较密码；不能把反斜杠直接交给 printf %b，也不允许 NUL。
  if [[ "$encoded" == *'\'* || "$encoded" == *'%00'* || "${encoded//%[[:xdigit:]][[:xdigit:]]/}" == *'%'* ]]; then
    echo "Demo scheduler.env 的 $1 密码编码无效" >&2
    return 1
  fi
  printf -v decoded '%b' "${encoded//%/\\x}"
  if [[ "$decoded" != "$(shared_value infra.env "$password_key")" ]]; then
    echo "Demo scheduler.env 的 $1 凭据与 infra.env 不一致" >&2
    return 1
  fi
}
verify_scheduler_configuration() {
  local scheduler_key
  verify_scheduler_database WEBHOOK_DISPATCHER WEBHOOK_DISPATCHER_DATABASE_URL || return 1
  verify_scheduler_database TRAJECTORY_DIRECTORY DATABASE_TRAJECTORY_DIRECTORY_URL || return 1
  if [[ -n "$(shared_value scheduler.env DATABASE_WORKER_COORDINATOR_URL)" ]]; then
    echo "Demo scheduler.env 不得包含 Worker Coordinator 凭据" >&2
    return 1
  fi
  scheduler_key="$(shared_value scheduler.env WEBHOOK_SECRET_ENCRYPTION_KEY)"
  if (( ${#scheduler_key} < 32 )) ||
    [[ "$(shared_value api.env WEBHOOK_SECRET_ENCRYPTION_KEY)" != "$scheduler_key" ]]; then
    echo "Demo api.env 与 scheduler.env 必须配置相同且不少于 32 字节的 WEBHOOK_SECRET_ENCRYPTION_KEY" >&2
    return 1
  fi
}
if ! verify_scheduler_configuration; then
  exit 2
fi

verify_object_storage_configuration() {
  # 只接受“KEY=值”的最简单行：不加引号、无注释、无空白、无 CR、无 $ 插值，且每个键恰好一行。
  # 预检不实现 dotenv/Compose 的完整语法，避免与运行时解析产生偏差；不满足时要求改写为该形式。
  local file key lines value
  local simple_value="^[^][:space:][:cntrl:]\"#\$\\\\']+\$"
  for file in scheduler.env admin-control.env; do
    for key in S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE; do
      lines="$(grep -c "^[[:space:]]*$key[[:space:]]*=" "$shared_dir/$file" || true)"
      if [[ "$lines" == 0 ]]; then
        echo "Demo $file 缺少环境变量：$key" >&2
        return 1
      fi
      value="$(sed -n "s/^$key=//p" "$shared_dir/$file")"
      if [[ "$lines" != 1 || ! "$value" =~ $simple_value ]]; then
        echo "Demo $file 环境变量格式无效：$key（须为不加引号、无空白和注释的单行 $key=值）" >&2
        return 1
      fi
      if [[ "$key" == S3_FORCE_PATH_STYLE && "$value" != true && "$value" != false ]]; then
        echo "Demo $file 环境变量无效：$key" >&2
        return 1
      fi
    done
  done
}
if ! verify_object_storage_configuration; then
  exit 2
fi

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
    printf 'HOOX_DEMO_RELEASE_ID=%s\n' "$(basename "$release_dir")"
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

compose() (
  # 发布调用方仍携带候选镜像；所有插值只取自原子写入的 compose.env，回滚也不能例外。
  unset HOOX_DEMO_IMAGE HOOX_DEMO_ROOT HOOX_DEMO_RELEASE_DIR HOOX_DEMO_RELEASE_ID DEMO_TENANT_ID DEMO_ADMIN_USER_ID
  docker compose --project-name hoox-demo --env-file "$compose_env" -f "$compose_file" "$@"
)

# shellcheck source=deploy/demo/runtime-config.sh
source "$(dirname "${BASH_SOURCE[0]}")/runtime-config.sh"

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local curl_config="${3:-}"
  local curl_options=(--fail --silent --show-error --max-time 5)
  if [[ -n "$curl_config" ]]; then
    curl_options+=(--config "$curl_config")
  fi
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl "${curl_options[@]}" "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_worker_started() {
  local container_id state
  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    container_id="$(compose ps -q worker)"
    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{.State.Running}}|{{.RestartCount}}' "$container_id")"
      # 短暂 Running 不证明已开始消费；启动失败重启必须让发布失败，而不是由 API readiness 掩盖。
      if [[ "$state" != "true|0" ]]; then
        echo "Demo Worker 启动失败或发生重启" >&2
        return 1
      fi
      if docker logs "$container_id" 2>&1 | grep -Fx 'Agent Worker 开发进程已启动' >/dev/null; then
        return 0
      fi
    fi
    sleep 2
  done
  echo "Demo Worker 未在期限内完成启动" >&2
  return 1
}

rollback() {
  local status=$?
  trap - EXIT
  if (( status == 0 )); then
    return 0
  fi
  # 回滚中的清理失败不能遮蔽原始错误，也不能阻止继续恢复上一版本。
  set +e
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
  compose stop admin-control admin-web >/dev/null 2>&1 || true
  compose stop api web scheduler worker >/dev/null 2>&1 || true
  if [[ -n "$previous_release" && -f "$previous_release/docker-compose.yml" && -n "$previous_image" ]]; then
    release_dir="$previous_release"
    compose_file="$previous_release/docker-compose.yml"
    write_compose_env "$previous_image" "$existing_tenant" "$existing_admin_user"
    local -a restore_services=(postgres minio api web scheduler worker)
    if compose config --services | grep -qx 'admin-control'; then
      restore_services+=(admin-control admin-web)
    fi
    # 兼容回滚到仍声明独立轨迹服务的旧版本：升级时 --remove-orphans 已删除其容器。
    if compose config --services | grep -qx 'trajectory'; then
      restore_services+=(trajectory)
    fi
    compose up -d --force-recreate "${restore_services[@]}" || true
    ln -sfn "$previous_release" "$root/current"
  fi
  echo "Hoox Demo 发布失败，已尝试恢复上一应用版本；数据库迁移不会自动回退" >&2
  exit "$status"
}
# EXIT 覆盖显式 exit，且只在主 shell 回滚，避免命令替换中的失败重复恢复。
trap rollback EXIT

compose pull api web admin-control admin-web scheduler worker migrate
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$shared_dir/admin-control.env,dst=/config/admin-control.env" \
  --mount "type=bind,src=$shared_dir/worker.env,dst=/config/worker.env" \
  --mount "type=bind,src=$shared_dir/scheduler.env,dst=/config/scheduler.env" \
  "$image" node scripts/prepare-demo-sandbox-key.mjs
# 重建前仍连着上一 epoch 的数据库；切换数据卷时这是保住配置的最后时机。
export_runtime_config before-deploy
compose up -d --force-recreate postgres minio
# 只经 TCP 判定就绪：首次初始化期间的临时服务器只监听 Unix socket，避免与初始化脚本并发。
postgres_ready=false
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  if compose exec -T postgres sh -c 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; then
    postgres_ready=true
    break
  fi
  sleep 2
done
if [[ "$postgres_ready" != "true" ]]; then
  echo "Demo PostgreSQL 未在期限内就绪" >&2
  exit 1
fi
# 保留数据卷时初始化脚本不会自动执行；发布前幂等补齐新增的受限角色（如 Webhook Dispatcher），
# 角色与密码只来自容器内 infra.env，不经宿主机命令行。
compose exec -T postgres sh /docker-entrypoint-initdb.d/10-hoox-demo.sh
# 已有角色不改密码；复用 Scheduler 服务的环境文件、网络与 DSN 做真实认证，失败时禁止迁移。
# pg 仅声明在 Scheduler 包中，必须从该包解析，且不得把底层连接错误中的凭据写入日志。
compose --profile ops run --rm --no-deps --entrypoint node scheduler --input-type=module -e '
  import { createRequire } from "node:module";
  const { Client } = createRequire(`${process.cwd()}/runtime-ts/apps/scheduler/package.json`)("pg");
  for (const key of ["WEBHOOK_DISPATCHER_DATABASE_URL", "DATABASE_TRAJECTORY_DIRECTORY_URL"]) {
    let client;
    try {
      if (!process.env[key]) throw new Error();
      client = new Client({connectionString: process.env[key], connectionTimeoutMillis: 10000, query_timeout: 10000});
      await client.connect();
      await client.query("SELECT 1");
    } catch {
      console.error(`Demo Scheduler 的 ${key} 数据库认证探针失败，已停止迁移`);
      process.exitCode = 1;
      break;
    } finally {
      await client?.end().catch(() => {});
    }
  }
'
compose --profile ops run --rm minio-init
compose --profile ops run --rm migrate
restore_runtime_config
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
if [[ ! "$DEV_ADMIN_CONTROL_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] ||
  (( ${#DEV_ADMIN_CONTROL_TOKEN} < 32 || ${#DEV_ADMIN_CONTROL_TOKEN} > 512 )); then
  echo "Demo Admin Control Token 格式无效" >&2
  exit 1
fi
if ! sudo test -f "/etc/letsencrypt/live/$domain/fullchain.pem" || ! sudo test -f "/etc/letsencrypt/live/$domain/privkey.pem"; then
  echo "Demo TLS 证书尚未初始化" >&2
  exit 1
fi
nginx_candidate="$(mktemp)"
admin_token_candidate="$(mktemp)"
admin_curl_config="$(mktemp)"
temporary_files+=("$nginx_candidate" "$admin_token_candidate" "$admin_curl_config")
chmod 0600 "$admin_curl_config"
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
printf 'proxy_set_header Authorization "Bearer %s";\n' "$DEV_ADMIN_CONTROL_TOKEN" \
  >"$admin_token_candidate"
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
demo_account_exists="$(printf '%s\n' \
  "SELECT EXISTS(SELECT 1 FROM :\"runtime_schema\".better_auth_users WHERE email=lower(:'demo_email'))::text;" \
  | compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set=runtime_schema="$DATABASE_SCHEMA" \
      --set=demo_email="$DEMO_ACCOUNT_EMAIL" \
      --tuples-only --no-align)"
if [[ "$demo_account_exists" != "true" && "$demo_account_exists" != "false" ]]; then
  echo "Demo 账号存在性检查失败" >&2
  exit 1
fi
cookie_jar="$(mktemp)"
account_response="$(mktemp)"
temporary_files+=("$cookie_jar" "$account_response")
if [[ "$demo_account_exists" == "false" ]]; then
  # 已有账号继续使用原凭据；注册关闭、重复注册防护或邮件发送策略不应阻断重复发布。
  signup_status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output "$account_response" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Origin: https://$domain" \
  --header "Referer: https://$domain/" \
  --cookie-jar "$cookie_jar" \
  --data "$account_payload" \
    "https://$domain/api/api/auth/sign-up/email")"
  if [[ "$signup_status" != "200" && "$signup_status" != "201" && "$signup_status" != "409" && "$signup_status" != "422" ]]; then
    echo "Demo 账号注册失败：HTTP $signup_status" >&2
    exit 1
  fi
fi
demo_identity_verified="$(printf '%s\n' \
  "WITH target AS (UPDATE :\"runtime_schema\".better_auth_users SET email_verified=true,updated_at=clock_timestamp() WHERE email=lower(:'demo_email') RETURNING email_verified) SELECT email_verified::text FROM target LIMIT 1;" \
  | compose exec -T postgres psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --set=runtime_schema="$DATABASE_SCHEMA" \
      --set=demo_email="$DEMO_ACCOUNT_EMAIL" \
      --tuples-only --no-align)"
if [[ "$demo_identity_verified" != "true" ]]; then
  echo "Demo 账号邮箱验证初始化失败" >&2
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
signin_status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output "$account_response" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --header "Origin: https://$domain" \
  --header "Referer: https://$domain/" \
  --cookie "$cookie_jar" --cookie-jar "$cookie_jar" \
  --data "$signin_payload" \
  "https://$domain/api/api/auth/sign-in/email")"
if [[ "$signin_status" != "200" ]]; then
  echo "Demo 账号登录初始化失败：HTTP $signin_status" >&2
  exit 1
fi
exchange_status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output "$account_response" --write-out '%{http_code}' \
  --request POST --header "Origin: https://$domain" --cookie "$cookie_jar" \
  "https://$domain/api/v1/auth/exchange")"
if [[ "$exchange_status" != "200" ]]; then
  echo "Demo 账号 Session 交换失败" >&2
  exit 1
fi
admin_access_token="$(python3 - "$account_response" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as response_file:
    payload = json.load(response_file)
token = payload.get("data", {}).get("accessToken")
if not isinstance(token, str) or not token.startswith("hoox_session_"):
    raise SystemExit(1)
print(token)
PY
)"
printf 'header = "Authorization: Bearer %s"\n' "$admin_access_token" >"$admin_curl_config"
rm -f "$cookie_jar" "$account_response"

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
compose up -d --remove-orphans --force-recreate api admin-control admin-web scheduler worker
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
wait_worker_started
wait_http "http://127.0.0.1:3001/ready"
wait_http "http://127.0.0.1:3003/ready"
wait_http "https://$domain/api/ready"
wait_http "https://$domain/admin/"
unauthorized_status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' \
  "https://$domain/v1/admin/control/overview")"
if [[ "$unauthorized_status" != "401" ]]; then
  echo "Demo 后台 API 未拒绝无会话请求" >&2
  exit 1
fi
wait_http "https://$domain/v1/admin/control/overview" 60 "$admin_curl_config"

ln -sfn "$release_dir" "$root/current"
if (( ${#temporary_files[@]} > 0 )); then
  rm -f -- "${temporary_files[@]}"
fi
trap - EXIT
export_runtime_config after-deploy

find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk 'NR>5 {print $2}' \
  | while IFS= read -r old_release; do
      if [[ "$old_release" != "$release_dir" && "$old_release" != "$previous_release" ]]; then
        rm -rf -- "$old_release"
      fi
    done

echo "Hoox Demo 发布完成：$release_id"
