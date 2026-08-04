import { fileURLToPath } from "node:url";
import { startDevelopmentResourceFsProxy } from "../runtime-ts/apps/api/development-resourcefs-proxy.mjs";

export {
  RESOURCE_FILESYSTEM_PATH_PREFIX,
  createDevelopmentResourceFsProxyHandler,
  isResourceFilesystemPath,
  startDevelopmentResourceFsProxy,
} from "../runtime-ts/apps/api/development-resourcefs-proxy.mjs";

async function main() {
  const listenHost = requiredEnvironment("RESOURCEFS_PROXY_LISTEN_HOST");
  const listenPort = positiveIntegerEnvironment("RESOURCEFS_PROXY_LISTEN_PORT");
  const upstream = requiredEnvironment("RESOURCEFS_PROXY_UPSTREAM");
  const privateKeyPath = requiredEnvironment("RESOURCEFS_PROXY_TLS_KEY_PATH");
  const certificatePath = requiredEnvironment("RESOURCEFS_PROXY_TLS_CERT_PATH");
  await startDevelopmentResourceFsProxy({
    listenHost,
    listenPort,
    upstream,
    privateKeyPath,
    certificatePath,
  });
  process.stdout.write(`ResourceFS development proxy listening on ${listenHost}:${listenPort}\n`);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`缺少 ${name}`);
  return value;
}

function positiveIntegerEnvironment(name) {
  const parsed = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new TypeError(`${name} 必须是有效端口`);
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
