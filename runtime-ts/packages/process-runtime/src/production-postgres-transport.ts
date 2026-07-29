const allowedProtocols = new Set(["postgres:", "postgresql:"]);

export interface ProductionPostgresTransport {
  readonly connectionString: string;
  readonly ssl: Readonly<{ readonly rejectUnauthorized: true }>;
}

/**
 * production 数据库 URL 只把 `sslmode=verify-full` 当作部署声明；传给 pg 前移除 query，
 * 并显式设置 Node TLS 的 rejectUnauthorized。证书链与主机名由 Node 系统信任库（含进程启动时
 * 配置的 NODE_EXTRA_CA_CERTS）验证，URL 不得另行指定 CA、证书、options 或会话参数。
 */
export function parseProductionPostgresTransport(value: string): ProductionPostgresTransport {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("PRODUCTION_DATABASE_TRANSPORT_INVALID");
  }
  if (
    !allowedProtocols.has(url.protocol) ||
    url.hostname.length === 0 ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.port.length === 0 ||
    !/^[1-9][0-9]{0,4}$/u.test(url.port) ||
    Number(url.port) > 65_535 ||
    url.pathname.length <= 1 ||
    url.hash !== ""
  ) {
    throw new TypeError("PRODUCTION_DATABASE_TRANSPORT_INVALID");
  }

  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "sslmode" || entries[0]?.[1] !== "verify-full") {
    // 严格单参数同时拒绝 require/prefer/no-verify/disable、重复 sslmode，以及 options、
    // search_path、application_name、sslcert/sslkey/sslrootcert 等所有 URL 覆盖通道。
    throw new TypeError("PRODUCTION_DATABASE_TRANSPORT_INVALID");
  }
  url.search = "";
  return Object.freeze({
    connectionString: url.toString(),
    ssl: Object.freeze({ rejectUnauthorized: true as const }),
  });
}
