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
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runDocker(arguments_, options = {}) {
  const result = dockerResult(arguments_, options);
  if (result.status !== 0) throw new Error(`DOCKER_COMMAND_FAILED:${arguments_[0] ?? "unknown"}`);
  return result.output.trim();
}

const canaryPath = join(process.cwd(), ".env.production-worker-gate-canary");
const secretCanary = "production-worker-secret-canary-must-not-appear";
let imageId;
let primaryFailure;
let cleanupFailure;
let createdCanary = false;

try {
  // 不读取、覆盖或恢复用户 .env；只允许创建此前不存在且精确命名的临时 canary。
  if (existsSync(canaryPath)) throw new Error("PRODUCTION_GATE_CANARY_PATH_EXISTS");
  writeFileSync(canaryPath, `GATE_SECRET=${secretCanary}\n`, { encoding: "utf8", flag: "wx" });
  createdCanary = true;

  const contextProbe = dockerResult(
    ["build", "--file", "Dockerfile.production-worker-context-probe", "."],
    { capture: true },
  );
  if (contextProbe.status === 0) throw new Error("DOCKER_BUILD_CONTEXT_CONTAINS_PRODUCTION_CANARY");

  const buildOutput = runDocker(
    ["build", "--quiet", "--file", "Dockerfile.production-worker-gate", "."],
    {
      capture: true,
    },
  );
  // Windows Docker daemon 偶发把已关闭 named pipe 的诊断写到 stderr；build 已成功时仍从 stdout 中的
  // digest 精确取镜像 ID，不能把该宿主诊断误判为镜像构建失败。
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
    'test "$(id -u)" = 1000; test -f /opt/runtime/dist/production-main.js; test -f /opt/runtime/sbom/cyclonedx.json; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/LICENSE; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/SOURCE.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.md; test -f /opt/runtime/licenses/vendor/cubesandbox-sdk/PATCHES/CUBE-LOCAL-0001-explicit-config-authority.patch; ! command -v python; ! command -v python3; ! command -v npm; ! command -v npx; ! command -v corepack; ! command -v pnpm; test ! -e /usr/local/lib/node_modules/npm; test ! -e /usr/local/lib/node_modules/corepack; test ! -e /opt/runtime/.env.production-worker-gate-canary; test ! -e /opt/runtime/CubeSandbox; test ! -e /opt/runtime/cubesandbox-agent-lab; test ! -d /opt/runtime/src; test ! -e /opt/runtime/dist/development-main.js; test ! -e /opt/runtime/dist/development-preflight-main.js; for tool in biome tsc tsx vitest; do test -z "$(find /opt/runtime -path "*/node_modules/.bin/$tool" -print -quit)"; done; for pattern in "*.test.*" "*.spec.*" "*.ts" "*.tsx"; do test -z "$(find /opt/runtime -type f -name "$pattern" -print -quit)"; done; for directory in test tests testing __tests__; do test -z "$(find /opt/runtime -type d -name "$directory" -print -quit)"; done',
  ]);

  const baseEnvironment = [
    "RUNTIME_ENV=production",
    `DATABASE_URL=postgresql://runtime:${secretCanary}@127.0.0.1:1/runtime?sslmode=verify-full`,
    "DATABASE_RUNTIME_ROLE=runtime",
    `DATABASE_WORKER_COORDINATOR_URL=postgresql://worker_coordinator:${secretCanary}@127.0.0.1:1/runtime?sslmode=verify-full`,
    "DATABASE_WORKER_COORDINATOR_ROLE=worker_coordinator",
    "DATABASE_SCHEMA=runtime",
    "S3_ENDPOINT=https://object-storage.invalid",
    "S3_BUCKET=runtime-artifacts",
    "S3_REGION=us-east-1",
    "S3_ACCESS_KEY_ID=production-access-placeholder",
    `S3_SECRET_ACCESS_KEY=${secretCanary}`,
    "S3_FORCE_PATH_STYLE=true",
    "CUBESANDBOX_API_URL=https://sandbox.invalid",
    "CUBESANDBOX_TEMPLATE_ID=template-placeholder",
    "CUBESANDBOX_PROXY_SCHEME=https",
    "CUBESANDBOX_RESOURCE_VOLUME_DRIVER=runtime-resourcefs",
    "MODEL_BASE_URL=https://model.invalid/v1",
    `MODEL_API_KEY=${secretCanary}`,
    "MODEL_ID=model-placeholder",
    "MODEL_SUPPORTS_IMAGES=false",
    "MODEL_CONTEXT_WINDOW=128000",
    "MODEL_MAX_OUTPUT_TOKENS=16384",
    "MODEL_WIRE_TRACE_ENABLED=false",
    "MODEL_WIRE_TRACE_RETENTION_DAYS=7",
    "MODEL_WIRE_TRACE_MAX_BYTES=1048576",
    "AGENT_WORKER_TENANT_ID=tenant_production_gate",
    "AGENT_WORKER_ID=production_gate_worker",
    "AGENT_WORKER_POLL_INTERVAL_MS=1000",
    "AGENT_WORKER_DISPATCH_LEASE_MS=30000",
    "AGENT_WORKER_RUN_LEASE_MS=30000",
    "AGENT_WORKER_RUN_TIMEOUT_MS=900000",
    "PROCESS_SHUTDOWN_TIMEOUT_MS=15000",
  ];
  const environmentArguments = baseEnvironment.flatMap((value) => ["--env", value]);

  // 真实外部设施在本 Gate 中故意不存在：不得把容器可构建误报为 ready，必须失败关闭且不泄密。
  const unavailable = dockerResult(
    ["run", "--rm", ...runtimeSandboxArguments, ...environmentArguments, imageId],
    {
      capture: true,
    },
  );
  if (unavailable.status === 0) throw new Error("PRODUCTION_WORKER_GATE_FALSE_READY");
  if (
    !unavailable.output.includes("Agent Worker 生产进程启动失败") ||
    unavailable.output.includes("Agent Worker 生产进程已启动")
  ) {
    throw new Error("PRODUCTION_WORKER_GATE_FAILURE_SEMANTICS_INVALID");
  }
  if (unavailable.output.includes(secretCanary)) {
    throw new Error("PRODUCTION_WORKER_GATE_OUTPUT_LEAKED_SECRET");
  }

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
    const rejected = dockerResult(
      [
        "run",
        "--rm",
        ...runtimeSandboxArguments,
        ...environmentArguments,
        "--env",
        `${key}=${value}`,
        imageId,
      ],
      { capture: true },
    );
    if (
      rejected.status === 0 ||
      !rejected.output.includes("production inherited environment rejected") ||
      rejected.output.includes("Agent Worker 生产进程已启动") ||
      rejected.output.includes(secretCanary) ||
      rejected.output.includes("pre-node-canary")
    ) {
      throw new Error(`PRODUCTION_WORKER_GATE_INHERITED_ENVIRONMENT_INVALID:${key}`);
    }
  }

  const futureNodeEnvironment = dockerResult(
    [
      "run",
      "--rm",
      ...runtimeSandboxArguments,
      ...environmentArguments,
      "--env",
      "node_future_transport_override=1",
      imageId,
    ],
    { capture: true },
  );
  if (
    futureNodeEnvironment.status === 0 ||
    !futureNodeEnvironment.output.includes("Agent Worker 生产进程启动失败") ||
    futureNodeEnvironment.output.includes(secretCanary)
  ) {
    throw new Error("PRODUCTION_WORKER_GATE_FUTURE_NODE_ENVIRONMENT_INVALID");
  }

  for (const key of ["CUBE_API_KEY", "E2B_API_KEY", "CUBE_PROXY_NODE_IP"]) {
    const rejected = dockerResult(
      [
        "run",
        "--rm",
        ...runtimeSandboxArguments,
        ...environmentArguments,
        "--env",
        `${key}=ambient-cube-attacker-key`,
        imageId,
      ],
      { capture: true },
    );
    if (
      rejected.status === 0 ||
      !rejected.output.includes("Agent Worker 生产进程启动失败") ||
      rejected.output.includes(secretCanary) ||
      rejected.output.includes("ambient-cube-attacker-key")
    ) {
      throw new Error(`PRODUCTION_WORKER_GATE_VENDOR_ENVIRONMENT_INVALID:${key}`);
    }
  }

  // development fixture 即使为 false 也必须在连接任何外部依赖之前拒绝。
  const forbiddenDevelopment = dockerResult(
    [
      "run",
      "--rm",
      ...runtimeSandboxArguments,
      ...environmentArguments,
      "--env",
      "DEV_AUTH_ENABLED=false",
      imageId,
    ],
    { capture: true },
  );
  if (forbiddenDevelopment.status === 0) {
    throw new Error("PRODUCTION_WORKER_GATE_ACCEPTED_DEVELOPMENT_IDENTITY");
  }
  if (
    !forbiddenDevelopment.output.includes("Agent Worker 生产进程启动失败") ||
    forbiddenDevelopment.output.includes(secretCanary)
  ) {
    throw new Error("PRODUCTION_WORKER_GATE_DEVELOPMENT_REJECTION_INVALID");
  }

  // Cube 管理面即使没有 API key 也会执行 create/delete/probe，production 仍必须拒绝明文 HTTP。
  const plaintextCubeWithoutKey = dockerResult(
    [
      "run",
      "--rm",
      ...runtimeSandboxArguments,
      ...environmentArguments,
      "--env",
      "CUBESANDBOX_API_URL=http://sandbox.invalid",
      imageId,
    ],
    { capture: true },
  );
  if (
    plaintextCubeWithoutKey.status === 0 ||
    !plaintextCubeWithoutKey.output.includes("Agent Worker 生产进程启动失败") ||
    plaintextCubeWithoutKey.output.includes(secretCanary)
  ) {
    throw new Error("PRODUCTION_WORKER_GATE_PLAINTEXT_CUBE_REJECTION_INVALID");
  }
} catch (error) {
  primaryFailure = error;
} finally {
  // 初始即存在的同名文件属于用户；拒绝执行时绝不能顺手删除它。
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
