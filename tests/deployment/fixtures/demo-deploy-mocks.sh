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
  if [[ "$*" == *'config --services'* ]]; then
    printf 'postgres\nminio\napi\nweb\nadmin-control\nadmin-web\ntrajectory\nscheduler\nworker\n'
  elif [[ "$*" == *'exec -T postgres psql'* ]]; then
    local query
    query="$(cat)"
    if [[ "$query" == 'SELECT EXISTS('* ]]; then
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
    elif [[ "$*" == *'/v1/admin/control/overview'* || "$*" == *'/trajectory/api/threads'* ]]; then
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
