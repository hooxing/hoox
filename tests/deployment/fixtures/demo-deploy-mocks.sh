#!/usr/bin/env bash
set -euo pipefail

# 完整执行真实发布脚本，仅替换外部进程；所有可写文件都位于测试临时目录。
export HOOX_DEMO_ROOT="$(cd "$FIXTURE_ROOT" && pwd)"
export TMPDIR="$HOOX_DEMO_ROOT/tmp"

docker() {
  printf 'docker %s\n' "$*" >>"$MOCK_LOG"
  if [[ "$*" == *' pull '* && "$MOCK_MODE" == command-failure ]]; then
    return 37
  fi
  if [[ "$*" == *'--entrypoint node scheduler --input-type=module -e'* ]]; then
    local probe="${!#}" scheduler_url
    scheduler_url="$(sed -n 's/^WEBHOOK_DISPATCHER_DATABASE_URL=//p' "$HOOX_DEMO_ROOT/shared/scheduler.env" | tail -n 1)"
    (
      cd "$HOOX_DEMO_ROOT"
      WEBHOOK_DISPATCHER_DATABASE_URL="$scheduler_url" node --input-type=module -e "$probe"
    )
    return
  fi
  if [[ "$*" == *'config --services'* ]]; then
    printf 'postgres\nminio\napi\nweb\nadmin-control\nadmin-web\nscheduler\nworker\n'
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
    printf 'test-container\n'
  elif [[ "$1" == inspect ]]; then
    if [[ "$*" == *'RestartCount'* ]]; then
      if [[ "$MOCK_MODE" == worker-restarting ]]; then
        printf 'true|3\n'
      else
        printf 'true|0\n'
      fi
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
ln() { printf 'ln %s\n' "$*" >>"$MOCK_LOG"; }
rm() {
  printf 'rm\n' >>"$MOCK_LOG"
  if [[ "$MOCK_MODE" == cleanup-failure ]]; then
    return 59
  fi
  command rm "$@"
}

source "$DEPLOY_SCRIPT"
