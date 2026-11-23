#!/usr/bin/env bash
set -euo pipefail

# 完整执行真实发布脚本，仅替换外部进程；所有可写文件都位于测试临时目录。
export HOOX_DEMO_ROOT="$(cd "$FIXTURE_ROOT" && pwd)"
export TMPDIR="$HOOX_DEMO_ROOT/tmp"

docker() {
  printf 'docker %s\n' "$*" >>"$MOCK_LOG"
  if [[ "$1" == compose ]]; then
    local env_file="" argument previous_argument="" service
    for argument in "$@"; do
      if [[ "$previous_argument" == --env-file ]]; then env_file="$argument"; fi
      previous_argument="$argument"
    done
    local resolved_image="${HOOX_DEMO_IMAGE-}" resolved_directory="${HOOX_DEMO_RELEASE_DIR-}"
    local resolved_release="${HOOX_DEMO_RELEASE_ID-}" resolved_tenant="${DEMO_TENANT_ID-}" resolved_admin="${DEMO_ADMIN_USER_ID-}"
    if [[ ! ${HOOX_DEMO_IMAGE+x} ]]; then resolved_image="$(sed -n 's/^HOOX_DEMO_IMAGE=//p' "$env_file" | tail -n 1)"; fi
    if [[ ! ${HOOX_DEMO_RELEASE_DIR+x} ]]; then resolved_directory="$(sed -n 's/^HOOX_DEMO_RELEASE_DIR=//p' "$env_file" | tail -n 1)"; fi
    if [[ ! ${HOOX_DEMO_RELEASE_ID+x} ]]; then resolved_release="$(sed -n 's/^HOOX_DEMO_RELEASE_ID=//p' "$env_file" | tail -n 1)"; fi
    if [[ ! ${DEMO_TENANT_ID+x} ]]; then resolved_tenant="$(sed -n 's/^DEMO_TENANT_ID=//p' "$env_file" | tail -n 1)"; fi
    if [[ ! ${DEMO_ADMIN_USER_ID+x} ]]; then resolved_admin="$(sed -n 's/^DEMO_ADMIN_USER_ID=//p' "$env_file" | tail -n 1)"; fi
    if [[ "$*" == *' up '* ]]; then
      printf 'up image=%s\n' "$resolved_image" >>"$MOCK_LOG"
      for service in "$@"; do
        case "$service" in
          api|web|admin-control|admin-web|scheduler|worker|trajectory)
            printf '%s' "$resolved_image|$resolved_directory|$resolved_release|$resolved_tenant|$resolved_admin" >"$FIXTURE_ROOT/$service.image"
            ;;
        esac
      done
    fi
  fi
  if [[ "$*" == *' pull '* && "$MOCK_MODE" == command-failure ]]; then
    return 37
  fi
  if [[ "$*" == *'--entrypoint node scheduler --input-type=module -e'* ]]; then
    local probe="${!#}" scheduler_url
    scheduler_url="$(sed -n 's/^WEBHOOK_DISPATCHER_DATABASE_URL=//p' "$FIXTURE_ROOT/shared/scheduler.env" | tail -n 1)"
    local directory_url
    directory_url="$(sed -n 's/^DATABASE_TRAJECTORY_DIRECTORY_URL=//p' "$FIXTURE_ROOT/shared/scheduler.env" | tail -n 1)"
    (
      cd "$FIXTURE_ROOT"
      DATABASE_TRAJECTORY_DIRECTORY_URL="$directory_url" WEBHOOK_DISPATCHER_DATABASE_URL="$scheduler_url" node --input-type=module -e "$probe"
    )
    return
  fi
  if [[ "$*" == *'config --services'* ]]; then
    printf 'postgres\nminio\napi\nweb\nadmin-control\nadmin-web\nscheduler\nworker\n'
    if [[ "$MOCK_MODE" == legacy-startup-failure ]]; then printf 'trajectory\n'; fi
  elif [[ "$*" == *'exec -T postgres pg_dump'* ]]; then
    if [[ "$MOCK_MODE" == config-export-dump-failure ]]; then
      return 23
    fi
    printf 'INSERT INTO test_schema.admin_control_config_revisions VALUES (1);\n'
  elif [[ "$*" == *'exec -T postgres psql'*'--single-transaction'* ]]; then
    printf 'config restore %s\n' "$(cat | tr '\n' ' ')" >>"$MOCK_LOG"
  elif [[ "$*" == *'exec -T postgres psql'* ]]; then
    local query
    query="$(cat)"
    if [[ "$query" == 'SELECT ((SELECT count(*)'* ]]; then
      # 模拟发布前旧库已有配置、迁移后的新库为空。
      if [[ "$MOCK_MODE" == config-export* ]]; then
        printf '5\n'
      elif [[ "$MOCK_MODE" == config-restore ]]; then
        printf '0\n'
      fi
    elif [[ "$query" == *"format('INSERT INTO %I.app_users"* ]]; then
      printf 'INSERT INTO test_schema.app_users VALUES (1);\n'
    elif [[ "$query" == *"format('UPDATE %I.admin_control_generation"* ]]; then
      printf 'UPDATE test_schema.admin_control_generation SET generation=5;\n'
    elif [[ "$query" == 'SELECT EXISTS('* ]]; then
      if [[ "$MOCK_MODE" == existing-account* ]]; then
        printf 'true\n'
      elif [[ "$MOCK_MODE" == account-lookup-invalid ]]; then
        printf 'unknown\n'
      else
        printf 'false\n'
      fi
    elif [[ "$query" == *'UPDATE '* ]]; then
      if [[ "$MOCK_MODE" == subshell-failure ]]; then
        return 41
      fi
      printf 'true\n'
    elif [[ "$query" == 'SELECT user_id'* ]]; then
      printf 'user_demo|tenant_demo\n'
    fi
  elif [[ "$*" == *' ps -q '* ]]; then
    printf 'test-%s-container\n' "${!#}"
  elif [[ "$1" == inspect ]]; then
    if [[ "$*" == *'RestartCount'* ]]; then
      if [[ "$MOCK_MODE" == worker-restarting ]]; then
        printf 'true|3\n'
      else
        printf 'true|0\n'
      fi
    elif [[ "$*" == *test-scheduler-container* && "$MOCK_MODE" == *startup-failure ]]; then
      printf 'false\n'
    else
      printf 'true\n'
    fi
  elif [[ "$1" == logs && "$MOCK_MODE" != worker-never-started ]]; then
    printf 'Agent Worker 开发进程已启动\n'
  fi
}

curl() {
  if [[ "$*" == *'/sign-up/email'* ]]; then
    printf 'curl signup\n' >>"$MOCK_LOG"
  elif [[ "$*" == *'/sign-in/email'* ]]; then
    printf 'curl signin\n' >>"$MOCK_LOG"
  fi
  if [[ "$*" == *'--write-out'* ]]; then
    if [[ "$*" == *'/sign-up/email'* && ( "$MOCK_MODE" == explicit-failure || "$MOCK_MODE" == cleanup-failure || "$MOCK_MODE" == existing-account* ) ]]; then
      printf '500'
    elif [[ "$*" == *'/sign-in/email'* && "$MOCK_MODE" == existing-account-signin-failure ]]; then
      printf '401'
    elif [[ "$*" == *'/v1/admin/control/overview'* ]]; then
      printf '401'
    else
      printf '200'
    fi
  fi
}

python3() {
  cat >/dev/null
  if (( $# > 1 )); then
    printf 'hoox_session_test_placeholder\n'
  else
    printf '{}\n'
  fi
}

sudo() { return 0; }
sleep() { return 0; }
find() { return 0; }
ln() { printf 'ln %s\n' "$*" >>"$MOCK_LOG"; command ln "$@"; }
rm() {
  printf 'rm\n' >>"$MOCK_LOG"
  if [[ "$MOCK_MODE" == cleanup-failure ]]; then
    return 59
  fi
  command rm "$@"
}

source "$DEPLOY_SCRIPT"
