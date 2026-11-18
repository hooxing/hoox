#!/usr/bin/env bash
# Demo 运行配置备份与恢复。由 remote-deploy.sh source，依赖调用方提供的
# shared_dir 与 compose()；也可在服务器上单独 source 后手工调用。

runtime_config_dir="$shared_dir/runtime-config"
runtime_config_latest="$runtime_config_dir/latest.sql"
runtime_config_keep=10
# 只保留全局模型、运行设置与沙箱配置。凭证仍是数据库中的密文，只有共享 env 中的
# 加密密钥不变时才能在新库中使用；备份不含 Tenant、Thread、Run 等业务数据。
runtime_config_tables=(
  admin_control_config_revisions
  admin_control_active_configs
  sandbox_provider_profiles
  sandbox_profile_probes
  sandbox_routing_revisions
  sandbox_routing_targets
)

infra_value() {
  sed -n "s/^$1=//p" "$shared_dir/infra.env" | tail -n 1
}

runtime_psql() {
  compose exec -T postgres psql \
    --username "$(infra_value POSTGRES_USER)" \
    --dbname "$(infra_value POSTGRES_DB)" \
    --set=ON_ERROR_STOP=1 \
    --set=runtime_schema="$(infra_value DATABASE_SCHEMA)" \
    "$@"
}

runtime_config_count() {
  printf '%s\n' \
    "SELECT ((SELECT count(*) FROM :\"runtime_schema\".admin_control_config_revisions)+(SELECT count(*) FROM :\"runtime_schema\".sandbox_provider_profiles))::text;" \
    | runtime_psql --tuples-only --no-align
}

# 备份失败只告警：它不能阻断发布，也绝不能用空结果覆盖上一份可用备份。
export_runtime_config() {
  local label="$1" count schema candidate
  count="$(runtime_config_count 2>/dev/null)" || count=""
  if [[ ! "$count" =~ ^[0-9]+$ ]] || ((count == 0)); then
    return 0
  fi
  schema="$(infra_value DATABASE_SCHEMA)"
  local -a dump_tables=()
  local table
  for table in "${runtime_config_tables[@]}"; do
    dump_tables+=(--table "$schema.$table")
  done
  install -d -m 0700 "$runtime_config_dir"
  candidate="$(mktemp "$runtime_config_dir/.candidate.XXXXXX")"
  chmod 0600 "$candidate"
  # if 条件中 set -e 不生效，三段输出必须用 && 串联，任一失败都不能写出半份备份。
  if ! {
    printf '%s\n' \
      "SELECT format('INSERT INTO %I.app_users(id,created_at) VALUES (%L,%L) ON CONFLICT (id) DO NOTHING;', :'runtime_schema', id, created_at) FROM :\"runtime_schema\".app_users WHERE id IN (SELECT created_by FROM :\"runtime_schema\".admin_control_config_revisions UNION SELECT activated_by FROM :\"runtime_schema\".admin_control_active_configs UNION SELECT created_by FROM :\"runtime_schema\".sandbox_provider_profiles UNION SELECT actor_user_id FROM :\"runtime_schema\".sandbox_profile_probes UNION SELECT created_by FROM :\"runtime_schema\".sandbox_routing_revisions) ORDER BY id;" \
      | runtime_psql --tuples-only --no-align &&
    compose exec -T postgres pg_dump \
      --username "$(infra_value POSTGRES_USER)" \
      --dbname "$(infra_value POSTGRES_DB)" \
      --data-only --inserts --no-owner --no-privileges "${dump_tables[@]}" &&
    printf '%s\n' \
      "SELECT format('UPDATE %I.admin_control_generation SET generation=%s, updated_at=clock_timestamp() WHERE singleton=%L;', :'runtime_schema', generation, singleton) FROM :\"runtime_schema\".admin_control_generation; SELECT format('UPDATE %I.sandbox_control_head SET generation=%s, routing_revision=%s WHERE singleton;', :'runtime_schema', generation, coalesce(routing_revision::text,'NULL')) FROM :\"runtime_schema\".sandbox_control_head;" \
      | runtime_psql --tuples-only --no-align
  } >"$candidate" 2>/dev/null || [[ ! -s "$candidate" ]]; then
    command rm -f -- "$candidate"
    echo "警告：Demo 运行配置备份失败，保留上一份备份" >&2
    return 0
  fi
  cp -p "$candidate" "$runtime_config_dir/runtime-config-$(date -u +%Y%m%dT%H%M%SZ)-$label.sql"
  mv -f "$candidate" "$runtime_config_latest"
  ls -1t "$runtime_config_dir"/runtime-config-*.sql 2>/dev/null \
    | tail -n "+$((runtime_config_keep + 1))" \
    | while IFS= read -r stale; do command rm -f -- "$stale"; done
  echo "已备份 Demo 运行配置：$label"
}

# 只在新库完全没有模型与沙箱配置时恢复，绝不覆盖运维已在新库中保存的配置。
# 单事务恢复失败时数据库保持原样，发布继续，由运维按告警手工处理。
restore_runtime_config() {
  local count
  if [[ ! -f "$runtime_config_latest" ]]; then
    return 0
  fi
  count="$(runtime_config_count 2>/dev/null)" || count=""
  if [[ "$count" != "0" ]]; then
    return 0
  fi
  if runtime_psql --single-transaction --quiet <"$runtime_config_latest" >/dev/null 2>&1; then
    echo "已从备份恢复 Demo 运行配置"
  else
    echo "警告：Demo 运行配置恢复失败，数据库未改动；请在后台重新配置或手工恢复 $runtime_config_latest" >&2
  fi
}
