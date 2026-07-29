import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
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
  if (result.status === 0) throw new Error(`PRODUCTION_SCHEDULER_FALSE_READY:${classification}`);
  if (
    !result.output.includes("Scheduler 生产进程启动失败") ||
    result.output.includes("Scheduler 生产进程已启动") ||
    result.output.includes(secretCanary)
  ) {
    throw new Error(`PRODUCTION_SCHEDULER_FAILURE_INVALID:${classification}`);
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
    result.output.includes("Scheduler 生产进程已启动") ||
    result.output.includes(secretCanary) ||
    result.output.includes("pre-node-canary")
  ) {
    throw new Error(`PRODUCTION_SCHEDULER_GATE_ENTRYPOINT_INVALID:${classification}`);
  }
}

const canaryPath = join(process.cwd(), ".env.production-scheduler-gate-canary");
const secretCanary = "production-scheduler-secret-canary-must-not-appear";
let imageId;
let primaryFailure;
let cleanupFailure;
let createdCanary = false;

try {
  if (existsSync(canaryPath)) throw new Error("PRODUCTION_SCHEDULER_CANARY_PATH_EXISTS");
  writeFileSync(canaryPath, `GATE_SECRET=${secretCanary}\n`, { encoding: "utf8", flag: "wx" });
  createdCanary = true;

  const contextProbe = dockerResult(
    ["build", "--file", "Dockerfile.production-scheduler-context-probe", "."],
    { capture: true },
  );
  if (contextProbe.status === 0) throw new Error("DOCKER_CONTEXT_CONTAINS_SCHEDULER_CANARY");

  const buildOutput = runDocker(
    ["build", "--quiet", "--file", "Dockerfile.production-scheduler-gate", "."],
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
    'test "$(id -u)" = 1000; test -f /opt/runtime/dist/production-main.js; test -f /opt/runtime/sbom/cyclonedx.json; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/LICENSE; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/SOURCE.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.patch; test ! -e /opt/runtime/.env.production-scheduler-gate-canary; test ! -d /opt/runtime/src; ! command -v python; ! command -v python3; ! command -v npm; ! command -v npx; ! command -v corepack; ! command -v pnpm; test ! -e /usr/local/lib/node_modules/npm; test ! -e /usr/local/lib/node_modules/corepack; for tool in biome tsc tsx vitest; do test -z "$(find /opt/runtime -path "*/node_modules/.bin/$tool" -print -quit)"; done; for pattern in "*.test.*" "*.spec.*" "*.ts" "*.tsx"; do test -z "$(find /opt/runtime -type f -name "$pattern" -print -quit)"; done; for directory in test tests testing __tests__; do test -z "$(find /opt/runtime -type d -name "$directory" -print -quit)"; done',
  ]);

  const baseEnvironment = Object.freeze({
    RUNTIME_ENV: "production",
    DATABASE_URL: `postgresql://runtime:${secretCanary}@127.0.0.1:1/runtime?sslmode=verify-full`,
    DATABASE_SCHEMA: "runtime",
    DATABASE_RUNTIME_ROLE: "runtime",
    CUBESANDBOX_API_URL: "https://127.0.0.1:1",
    CUBESANDBOX_API_KEY: secretCanary,
    CUBESANDBOX_PROXY_SCHEME: "https",
    SCHEDULER_TENANT_ID: "tenant_production_gate",
    SCHEDULER_WORKER_ID: "scheduler_production_gate",
    CLEANUP_POLL_INTERVAL_MS: "1000",
    CLEANUP_LEASE_MS: "210000",
    PROCESS_SHUTDOWN_TIMEOUT_MS: "15000",
  });

  assertClosedFailure(imageId, baseEnvironment, secretCanary, "postgres-unavailable");
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
  assertClosedFailure(imageId, missingDatabase, secretCanary, "postgres-missing");
  const { CUBESANDBOX_API_URL: _cubeApiUrl, ...missingCube } = baseEnvironment;
  assertClosedFailure(imageId, missingCube, secretCanary, "cube-missing");
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, CUBESANDBOX_API_KEY: "" },
    secretCanary,
    "cube-credential-invalid",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, DEV_AUTH_ENABLED: "false" },
    secretCanary,
    "development-variable",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, CUBESANDBOX_API_URL: "http://127.0.0.1:1" },
    secretCanary,
    "plaintext-cube-api",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, CUBESANDBOX_PROXY_SCHEME: "http" },
    secretCanary,
    "plaintext-cube-proxy",
  );
  assertClosedFailure(
    imageId,
    { ...baseEnvironment, DATABASE_RUNTIME_ROLE: "Runtime-Owner" },
    secretCanary,
    "runtime-role-invalid",
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
