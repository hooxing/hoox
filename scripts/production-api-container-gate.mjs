import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const baseDigest = "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const runtimeSandboxArguments = Object.freeze([
  "--read-only",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,noexec,mode=1777",
]);
const runtimeFilesystemProbe =
  'for path in /opt/runtime /opt/runtime/dist/production-main.js /opt/runtime/node_modules /opt/runtime/sbom/cyclonedx.json /opt/runtime/licenses; do test "$(stat -c %u:%g "$path")" = 0:0; done; test -z "$(find /opt/runtime -xdev \\( -type f -o -type d \\) -perm /022 -print -quit)"; ! touch /opt/runtime/runtime-write-probe 2>/dev/null; touch /tmp/runtime-write-probe; rm /tmp/runtime-write-probe';

function dockerResult(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runDocker(arguments_, options = {}) {
  const result = dockerResult(arguments_, options);
  if (result.status !== 0) throw new Error(`DOCKER_COMMAND_FAILED:${arguments_[0] ?? "unknown"}`);
  return result.output.trim();
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function assertClosedFailure(imageId, environment, secretCanary, classification) {
  const result = dockerResult(
    ["run", "--rm", ...runtimeSandboxArguments, ...environmentArguments(environment), imageId],
    {
      capture: true,
    },
  );
  if (result.status === 0) throw new Error(`PRODUCTION_API_GATE_FALSE_READY:${classification}`);
  if (
    !result.output.includes("API 生产进程启动失败") ||
    result.output.includes("API 生产进程已启动") ||
    result.output.includes(secretCanary)
  ) {
    throw new Error(`PRODUCTION_API_GATE_FAILURE_INVALID:${classification}`);
  }
}

function assertEntrypointClosedFailure(imageId, environment, secretCanary, classification) {
  const result = dockerResult(
    ["run", "--rm", ...runtimeSandboxArguments, ...environmentArguments(environment), imageId],
    {
      capture: true,
    },
  );
  if (
    result.status === 0 ||
    !result.output.includes("production inherited environment rejected") ||
    result.output.includes("API 生产进程已启动") ||
    result.output.includes(secretCanary) ||
    result.output.includes("pre-node-canary")
  ) {
    throw new Error(`PRODUCTION_API_GATE_ENTRYPOINT_INVALID:${classification}`);
  }
}

const canaryPath = join(process.cwd(), ".env.production-api-gate-canary");
const secretCanary = "production-api-secret-canary-must-not-appear";
let imageId;
let primaryFailure;
let cleanupFailure;
let createdCanary = false;

try {
  if (existsSync(canaryPath)) throw new Error("PRODUCTION_API_GATE_CANARY_PATH_EXISTS");
  writeFileSync(canaryPath, `GATE_SECRET=${secretCanary}\n`, { encoding: "utf8", flag: "wx" });
  createdCanary = true;

  const contextProbe = dockerResult(
    ["build", "--file", "Dockerfile.production-api-context-probe", "."],
    { capture: true },
  );
  if (contextProbe.status === 0) throw new Error("DOCKER_BUILD_CONTEXT_CONTAINS_API_CANARY");

  const buildOutput = runDocker(
    ["build", "--quiet", "--file", "Dockerfile.production-api-gate", "."],
    { capture: true },
  );
  imageId = /(?:^|\r?\n)(sha256:[a-f0-9]{64})(?:\r?\n|$)/u.exec(buildOutput)?.[1];
  if (imageId === undefined) throw new Error("DOCKER_IMAGE_ID_INVALID");

  const configuredUser = runDocker(["image", "inspect", "--format", "{{.Config.User}}", imageId], {
    capture: true,
  });
  if (configuredUser !== "1000:1000") throw new Error("DOCKER_IMAGE_USER_CONFIG_INVALID");
  const configuredCommand = runDocker(
    ["image", "inspect", "--format", "{{json .Config.Cmd}}", imageId],
    { capture: true },
  );
  if (configuredCommand !== '["node","dist/production-main.js"]') {
    throw new Error("DOCKER_IMAGE_COMMAND_INVALID");
  }
  const configuredEntrypoint = runDocker(
    ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", imageId],
    { capture: true },
  );
  if (configuredEntrypoint !== '["/usr/local/bin/production-entrypoint"]') {
    throw new Error("DOCKER_IMAGE_ENTRYPOINT_INVALID");
  }
  const configuredBaseDigest = runDocker(
    [
      "image",
      "inspect",
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.base.digest"}}',
      imageId,
    ],
    { capture: true },
  );
  if (configuredBaseDigest !== baseDigest) throw new Error("DOCKER_IMAGE_BASE_DIGEST_INVALID");

  runDocker([
    "run",
    "--rm",
    ...runtimeSandboxArguments,
    imageId,
    "sh",
    "-ec",
    runtimeFilesystemProbe,
  ]);

  runDocker([
    "run",
    "--rm",
    ...runtimeSandboxArguments,
    imageId,
    "sh",
    "-ec",
    'test "$(id -u)" = 1000; test -f /opt/runtime/dist/production-main.js; test -f /opt/runtime/sbom/cyclonedx.json; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/LICENSE; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/SOURCE.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.patch; test ! -e /opt/runtime/.env.production-api-gate-canary; test ! -d /opt/runtime/src; test ! -e /opt/runtime/dist/development-main.js; test ! -e /opt/runtime/dist/development-identity-main.js; ! command -v python; ! command -v python3; ! command -v npm; ! command -v npx; ! command -v corepack; ! command -v pnpm; test ! -e /usr/local/lib/node_modules/npm; test ! -e /usr/local/lib/node_modules/corepack; for tool in biome tsc tsx vitest; do test -z "$(find /opt/runtime -path "*/node_modules/.bin/$tool" -print -quit)"; done; for pattern in "*.test.*" "*.spec.*" "*.ts" "*.tsx"; do test -z "$(find /opt/runtime -type f -name "$pattern" -print -quit)"; done; for directory in test tests testing __tests__; do test -z "$(find /opt/runtime -type d -name "$directory" -print -quit)"; done',
  ]);

  const blobPathProbe = dockerResult(
    [
      "run",
      "--rm",
      ...runtimeSandboxArguments,
      "--interactive",
      imageId,
      "node",
      "--input-type=module",
      "-",
    ],
    {
      capture: true,
      input: readFileSync(
        join(process.cwd(), "scripts", "production-blob-path-container-probe.mjs"),
        "utf8",
      ),
    },
  );
  if (blobPathProbe.status !== 0) throw new Error("PRODUCTION_API_BLOB_PATH_PROBE_FAILED");

  const baseEnvironment = Object.freeze({
    RUNTIME_ENV: "production",
    DATABASE_URL: `postgresql://runtime:${secretCanary}@127.0.0.1:1/runtime?sslmode=verify-full`,
    DATABASE_SCHEMA: "runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    THREAD_CURSOR_ACTIVE_KID: "current",
    THREAD_CURSOR_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_ISSUER: "https://issuer.example.invalid/runtime",
    API_JWT_AUDIENCE: "cube-runtime-api",
    API_JWT_SIGNING_KEYS: "current:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_JWT_CLOCK_SKEW_SECONDS: "60",
    API_JWT_MAX_LIFETIME_SECONDS: "3600",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
    API_LISTEN_HOST: "127.0.0.1",
    API_LISTEN_PORT: "3001",
    API_PUBLIC_ORIGIN: "https://app.example.invalid",
    API_TLS_MODE: "proxy",
    API_TRUSTED_PROXY_CIDRS: "127.0.0.1",
    S3_ENDPOINT: "https://127.0.0.1:1",
    S3_PUBLIC_ENDPOINT: "https://objects.example.invalid",
    S3_BUCKET: "runtime-artifacts",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "production-access-placeholder",
    S3_SECRET_ACCESS_KEY: secretCanary,
    S3_FORCE_PATH_STYLE: "true",
  });

  // 本 Gate 故意不提供真实 PG/S3：真实 production entry 必须失败关闭且日志只保留稳定分类。
  assertClosedFailure(imageId, baseEnvironment, secretCanary, "external-unavailable");
  for (const [key, value] of Object.entries({
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_OPTIONS: "\n--import=data:text/javascript,process.stdout.write('pre-node-canary')",
    NODE_USE_ENV_PROXY: "1",
    NODE_USE_SYSTEM_CA: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "*",
    SSL_CERT_FILE: "/tmp/forbidden-ca.pem",
    SSL_CERT_DIR: "/tmp/forbidden-ca-directory",
    OPENSSL_CONF: "/tmp/forbidden-openssl.cnf",
    OPENSSL_MODULES: "/tmp/forbidden-openssl-modules",
    OPENSSL_ENGINES: "/tmp/forbidden-openssl-engines",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    all_proxy: "http://127.0.0.1:9",
    no_proxy: "*",
  })) {
    assertEntrypointClosedFailure(
      imageId,
      { ...baseEnvironment, [key]: value },
      secretCanary,
      `inherited-environment-${key}`,
    );
  }
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, node_future_transport_override: "1" },
    secretCanary,
    "future-node-environment-js-gate",
  );
  const { DATABASE_URL: _databaseUrl, ...missingDatabase } = baseEnvironment;
  assertClosedFailure(imageId, missingDatabase, secretCanary, "database-missing");
  const { S3_ENDPOINT: _s3Endpoint, ...missingObjectStorage } = baseEnvironment;
  assertClosedFailure(imageId, missingObjectStorage, secretCanary, "object-storage-missing");
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, DEV_AUTH_ENABLED: "false" },
    secretCanary,
    "development-identity",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, S3_ENDPOINT: "http://127.0.0.1:1" },
    secretCanary,
    "plaintext-object-storage",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, S3_PUBLIC_ENDPOINT: "https://app.example.invalid" },
    secretCanary,
    "same-origin-object-storage",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, API_LISTEN_HOST: "0.0.0.0" },
    secretCanary,
    "untrusted-plaintext-proxy",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, API_TLS_MODE: "direct", API_TRUSTED_PROXY_CIDRS: "" },
    secretCanary,
    "direct-tls-files-missing",
  );
  assertClosedFailure(
    imageId,
    {
      ...baseEnvironment,
      DATABASE_URL: `postgresql://runtime:${secretCanary}@127.0.0.1:1/runtime?sslmode=require`,
    },
    secretCanary,
    "postgres-verify-full-missing",
  );
} catch (error) {
  primaryFailure = error;
} finally {
  if (createdCanary) rmSync(canaryPath, { force: true });
  if (imageId !== undefined) {
    try {
      runDocker(["image", "rm", imageId]);
    } catch (error) {
      cleanupFailure = error;
    }
  }
}

if (primaryFailure !== undefined) throw primaryFailure;
if (cleanupFailure !== undefined) throw cleanupFailure;
