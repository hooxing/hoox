#!/bin/sh
set -eu

# Node/OpenSSL 会在 JS 入口前消费这些固定变量；直接参数展开可可靠识别包含换行的非空值。
if [ -n "${NODE_TLS_REJECT_UNAUTHORIZED-}" ] ||
  [ -n "${NODE_OPTIONS-}" ] ||
  [ -n "${NODE_USE_ENV_PROXY-}" ] ||
  [ -n "${NODE_USE_SYSTEM_CA-}" ] ||
  [ -n "${HTTP_PROXY-}" ] || [ -n "${http_proxy-}" ] ||
  [ -n "${HTTPS_PROXY-}" ] || [ -n "${https_proxy-}" ] ||
  [ -n "${ALL_PROXY-}" ] || [ -n "${all_proxy-}" ] ||
  [ -n "${NO_PROXY-}" ] || [ -n "${no_proxy-}" ] ||
  [ -n "${SSL_CERT_FILE-}" ] || [ -n "${SSL_CERT_DIR-}" ] ||
  [ -n "${OPENSSL_CONF-}" ] || [ -n "${OPENSSL_MODULES-}" ] ||
  [ -n "${OPENSSL_ENGINES-}" ]; then
  echo "production inherited environment rejected" >&2
  exit 64
fi

exec "$@"
