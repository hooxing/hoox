const allowedProductionNodeEnvironmentKeys = new Set([
  "NODE_ENV",
  "NODE_VERSION",
  "NODE_EXTRA_CA_CERTS",
]);
const forbiddenProductionInheritedEnvironmentKeys = new Set<string>([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
]);

/**
 * Node/OpenSSL 的继承环境可在声明配置之外改变 TLS、预加载代码或代理路由。production 在投影
 * 服务环境前拒绝任意非空覆盖；NODE_EXTRA_CA_CERTS 是 ADR 明示的唯一 CA 扩展通道。
 */
export function assertProductionInheritedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): void {
  if (
    source.RUNTIME_ENV === "production" &&
    Object.entries(source).some(([key, value]) => {
      if ((value?.length ?? 0) === 0) return false;
      const normalizedKey = key.toUpperCase();
      return (
        forbiddenProductionInheritedEnvironmentKeys.has(normalizedKey) ||
        normalizedKey.startsWith("CUBE_") ||
        normalizedKey === "E2B_API_KEY" ||
        (normalizedKey.startsWith("NODE_") &&
          !allowedProductionNodeEnvironmentKeys.has(normalizedKey))
      );
    })
  ) {
    throw new TypeError("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  }
}
