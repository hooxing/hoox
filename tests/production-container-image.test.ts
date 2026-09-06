import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: boundary.spawnSync }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: boundary.existsSync,
  writeFileSync: boundary.writeFileSync,
  rmSync: boundary.rmSync,
}));

const imageId = `sha256:${"a".repeat(64)}`;
const prebuiltImage = "hoox/production-gate:prebuilt-placeholder";
const baseDigest = "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const roles = [
  { role: "api", startupFailure: "API 生产进程启动失败" },
  { role: "scheduler", startupFailure: "Scheduler 生产进程启动失败" },
  { role: "worker", startupFailure: "Agent Worker 生产进程启动失败" },
] as const;

function result(stdout = "", status = 0, stderr = "") {
  return { status, stdout, stderr };
}

describe.each(roles)("生产 $role 容器镜像所有权与探针", ({ role, startupFailure }) => {
  let commands: string[][];
  let buildOutput: string;
  let buildStatus: number;
  let inspectedImageId: string;
  let imageOverrides: Record<string, string>;
  let inspectStatus: number;
  let cleanupStatus: number;
  let contextStatus: number;
  let runtimeStatus: number;

  function runGate() {
    // 导入真实入口，只替换 Docker 与 canary 文件边界，确保镜像来源不会绕过既有安全探针。
    return import(`../scripts/production-${role}-container-gate.mjs`);
  }

  function imageRemovals() {
    return commands.filter((command) => command[0] === "image" && command[1] === "rm");
  }

  function imageBuilds() {
    return commands.filter((command) => command[0] === "build" && command.includes("--quiet"));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("PRODUCTION_GATE_IMAGE", undefined);
    commands = [];
    buildOutput = imageId;
    buildStatus = 0;
    inspectedImageId = imageId;
    imageOverrides = {};
    inspectStatus = 0;
    cleanupStatus = 0;
    contextStatus = 1;
    runtimeStatus = 0;
    boundary.existsSync.mockReturnValue(false);
    boundary.spawnSync.mockImplementation((executable: string, arguments_: string[]) => {
      expect(executable).toBe("docker");
      commands.push(arguments_);
      if (arguments_[0] === "build") {
        return arguments_.includes("--quiet")
          ? result(buildOutput, buildStatus)
          : result("", contextStatus);
      }
      if (arguments_[0] === "image" && arguments_[1] === "rm") {
        return result("", cleanupStatus);
      }
      if (arguments_[0] === "image" && arguments_[1] === "inspect") {
        const format = arguments_[3] ?? "";
        if (format === "{{.Id}}") return result(inspectedImageId, inspectStatus);
        const metadata: Record<string, string> = {
          "{{.Config.User}}": "1000:1000",
          "{{json .Config.Cmd}}": '["node","dist/production-main.js"]',
          "{{json .Config.Entrypoint}}": '["/usr/local/bin/production-entrypoint"]',
          '{{index .Config.Labels "org.opencontainers.image.base.digest"}}': baseDigest,
          ...imageOverrides,
        };
        return result(metadata[format]);
      }
      if (arguments_[0] === "run") {
        if (arguments_.includes("--env")) {
          const inheritedOverride = arguments_.some((argument, index) => {
            if (arguments_[index - 1] !== "--env") return false;
            const key = argument.split("=")[0] ?? "";
            return (
              /^(NODE_|SSL_|OPENSSL_)|^(https?|all|no)_proxy$/iu.test(key) &&
              key !== "node_future_transport_override"
            );
          });
          return result(
            inheritedOverride ? "production inherited environment rejected" : startupFailure,
            1,
          );
        }
        const tokenizer = arguments_.some((argument) => argument.includes("countTokens("));
        return result(tokenizer ? "5" : "", runtimeStatus);
      }
      throw new Error("UNEXPECTED_DOCKER_COMMAND");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["local", "prebuilt"])("%s 镜像执行完整验证且只清理本次构建", async (source) => {
    if (source === "prebuilt") vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    await runGate();

    expect(commands[0]).toEqual([
      "build",
      "--file",
      `Dockerfile.production-${role}-context-probe`,
      ".",
    ]);
    expect(imageBuilds()).toHaveLength(source === "local" ? 1 : 0);
    expect(imageRemovals()).toEqual(source === "local" ? [["image", "rm", imageId]] : []);
    if (source === "prebuilt") {
      expect(commands[1]).toEqual(["image", "inspect", "--format", "{{.Id}}", prebuiltImage]);
    }
    const runtimeCommands = commands.filter((command) => command[0] === "run");
    expect(runtimeCommands.length).toBeGreaterThan(20);
    for (const command of runtimeCommands) {
      expect(command).toContain(imageId);
      expect(command).not.toContain(prebuiltImage);
      expect(command).toContain("--pull=never");
      expect(command).toContain("--read-only");
      expect(command).toContain("/tmp:rw,nosuid,nodev,noexec,mode=1777");
    }
    expect(boundary.rmSync).toHaveBeenCalledWith(
      join(process.cwd(), `.env.production-${role}-gate-canary`),
      { force: true },
    );
    expect(commands.some((command) => command[0] === "pull")).toBe(false);
  });

  it("本地构建成功附带 Windows 诊断时仍取得合法 ID 并清理", async () => {
    buildOutput = `${imageId}\r\nWindows named pipe diagnostic`;
    await runGate();
    expect(imageRemovals()).toEqual([["image", "rm", imageId]]);
  });

  it("构建失败即使输出合法 ID 也不取得运行或清理权", async () => {
    buildStatus = 1;
    await expect(runGate()).rejects.toThrow("DOCKER_COMMAND_FAILED:build");
    expect(commands.some((command) => command[0] === "run")).toBe(false);
    expect(imageRemovals()).toEqual([]);
    expect(boundary.rmSync).toHaveBeenCalledOnce();
  });

  it.each(["local", "prebuilt"])("%s 镜像 ID 无效时不运行或清理镜像", async (source) => {
    buildOutput = "invalid-image-output";
    inspectedImageId = "invalid-image-output";
    if (source === "prebuilt") vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    await expect(runGate()).rejects.toThrow("DOCKER_IMAGE_ID_INVALID");
    expect(commands.some((command) => command[0] === "run")).toBe(false);
    expect(imageRemovals()).toEqual([]);
    expect(boundary.rmSync).toHaveBeenCalledOnce();
  });

  it("预构建解析不接受混入诊断或多个 ID 的输出", async () => {
    vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    inspectedImageId = `${imageId}\n${imageId}`;
    await expect(runGate()).rejects.toThrow("DOCKER_IMAGE_ID_INVALID");
    expect(imageBuilds()).toEqual([]);
    expect(imageRemovals()).toEqual([]);
  });

  it("预构建镜像不存在时失败，不拉取也不回退构建", async () => {
    vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    inspectStatus = 1;
    await expect(runGate()).rejects.toThrow("DOCKER_COMMAND_FAILED:image");
    expect(imageBuilds()).toEqual([]);
    expect(imageRemovals()).toEqual([]);
    expect(commands.some((command) => command[0] === "pull")).toBe(false);
  });

  it.each([
    ["{{.Config.User}}", "root", "DOCKER_IMAGE_USER_CONFIG_INVALID"],
    ["{{json .Config.Cmd}}", "[]", "DOCKER_IMAGE_COMMAND_INVALID"],
    ["{{json .Config.Entrypoint}}", "[]", "DOCKER_IMAGE_ENTRYPOINT_INVALID"],
    [
      '{{index .Config.Labels "org.opencontainers.image.base.digest"}}',
      "",
      "DOCKER_IMAGE_BASE_DIGEST_INVALID",
    ],
  ])("预构建镜像仍检查 %s", async (format, value, error) => {
    vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    imageOverrides[format] = value;
    await expect(runGate()).rejects.toThrow(error);
    expect(imageRemovals()).toEqual([]);
  });

  it("预构建镜像仍拒绝运行时文件系统探针失败", async () => {
    vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    runtimeStatus = 1;
    await expect(runGate()).rejects.toThrow("DOCKER_COMMAND_FAILED:run");
    expect(imageRemovals()).toEqual([]);
  });

  it("预构建镜像仍拒绝 canary 泄入 build context", async () => {
    vi.stubEnv("PRODUCTION_GATE_IMAGE", prebuiltImage);
    contextStatus = 0;
    await expect(runGate()).rejects.toThrow();
    expect(commands).toHaveLength(1);
    expect(imageRemovals()).toEqual([]);
    expect(boundary.rmSync).toHaveBeenCalledOnce();
  });

  it("本地镜像验证失败仍清理，且主错误优先于全部清理错误", async () => {
    imageOverrides["{{.Config.User}}"] = "root";
    cleanupStatus = 1;
    boundary.rmSync.mockImplementation(() => {
      throw new Error("CANARY_CLEANUP_FAILED");
    });
    await expect(runGate()).rejects.toThrow("DOCKER_IMAGE_USER_CONFIG_INVALID");
    expect(imageRemovals()).toEqual([["image", "rm", imageId]]);
  });

  it("验证成功后的镜像清理错误仍使 Gate 失败", async () => {
    cleanupStatus = 1;
    await expect(runGate()).rejects.toThrow("DOCKER_COMMAND_FAILED:image");
  });

  it("验证成功后的 canary 清理错误不会阻止镜像清理", async () => {
    boundary.rmSync.mockImplementation(() => {
      throw new Error("CANARY_CLEANUP_FAILED");
    });
    await expect(runGate()).rejects.toThrow("CANARY_CLEANUP_FAILED");
    expect(imageRemovals()).toEqual([["image", "rm", imageId]]);
  });

  it("用户已有同名 canary 时不执行 Docker 或删除文件", async () => {
    boundary.existsSync.mockReturnValue(true);
    await expect(runGate()).rejects.toThrow("CANARY_PATH_EXISTS");
    expect(commands).toEqual([]);
    expect(boundary.writeFileSync).not.toHaveBeenCalled();
    expect(boundary.rmSync).not.toHaveBeenCalled();
  });
});
