import type { ResolvedSandboxProfile } from "@hoox/admin-control";
import type { ExecutionScope } from "@hoox/run-contracts";
import type { SandboxHandle } from "@hoox/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createManagedSandboxRegistry } from "./managed-sandbox-registry.js";
import {
  CubeSandboxSessionRegistry,
  SandboxSessionRegistryRouter,
} from "./production-worker-runtime.js";

const scope = {
  tenantId: "tenant-router",
  threadId: "thread-router",
  runId: "run-router",
  rootRunId: "run-router",
  workspaceId: "workspace-router",
} as ExecutionScope;
const profile: ResolvedSandboxProfile = {
  profileRevision: 1,
  routingRevision: 3,
  apiKey: "sandbox-placeholder-key",
  configuration: {
    providerKey: "tencent-ags",
    displayName: "腾讯云",
    endpoint: "sandbox.example.test",
    credentialConfigured: true,
    policy: {
      templateId: "managed-template",
      sessionTtlSeconds: 600,
      operationTimeoutMs: 45000,
      lifecycleTimeoutMs: 75000,
      pausedRetentionSeconds: 1800,
      idleAction: "pause",
    },
  },
};

function setup() {
  const fallback = new CubeSandboxSessionRegistry(
    { apiUrl: "http://cube.example.test:8080" },
    "legacy-template",
  );
  const registry = createManagedSandboxRegistry(profile, "example-driver");
  const handle: SandboxHandle = {
    id: "managed-remote",
    command: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    runCode: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    pause: vi.fn(),
    kill: vi.fn(),
  };
  const create = vi.spyOn(registry.gateway, "create").mockResolvedValue(handle);
  const connect = vi.spyOn(registry.gateway, "connect").mockResolvedValue(handle);
  const resolver = {
    bind: vi.fn(async () => profile as ResolvedSandboxProfile | undefined),
    resolve: vi.fn(async () => profile as ResolvedSandboxProfile | undefined),
    activeProfiles: vi.fn(async () => [profile] as readonly ResolvedSandboxProfile[] | undefined),
  };
  const factory = vi.fn(() => registry);
  return {
    fallback,
    registry,
    handle,
    create,
    connect,
    resolver,
    factory,
    router: new SandboxSessionRegistryRouter("cube", [fallback], {
      resolver,
      createRegistry: factory,
    }),
  };
}

describe("托管沙箱 Worker 路由", () => {
  it("创建前选定实际供应商，执行配置模板、TTL、超时及 Workspace 能力", async () => {
    const { router, create, resolver, handle } = setup();
    expect(await router.prepareCreate({ scope, registryId: "managed-registry" })).toEqual({
      providerKey: "tencent-ags",
      lifecycleTimeoutMs: 75000,
    });
    const result = await router.create({
      scope,
      registryId: "managed-registry",
      signal: new AbortController().signal,
      requiresResourceFilesystem: false,
    });
    expect(resolver.bind).toHaveBeenCalledWith({
      tenantId: scope.tenantId,
      registryId: "managed-registry",
    });
    expect(create).toHaveBeenCalledWith(
      {
        templateId: "managed-template",
        ttlSeconds: 600,
        lifecycle: { onTimeout: "kill", autoResume: false },
      },
      expect.objectContaining({ timeoutMs: 75000 }),
    );
    if (result.outcome !== "ready") throw new Error("测试沙箱未就绪");
    const capability = router.workspaceCapability({ scope, session: result.session });
    expect(await capability.current()).toMatchObject({ sessionId: handle.id });
    await router.settle({
      scope,
      session: result.session,
      cleanupIntentId: "test-cleanup",
      disposition: "close",
    });
    expect(handle.kill).toHaveBeenCalled();
  });
  it("恢复使用绑定版本，不调用新建分配器；身份不一致时阻止调用", async () => {
    const { router, resolver, connect } = setup();
    const input = {
      scope,
      registryId: "managed-registry",
      providerKey: "tencent-ags" as const,
      providerSandboxId: "managed-remote",
      signal: new AbortController().signal,
    };
    const result = await router.connect(input);
    expect(result.outcome).toBe("ready");
    expect(resolver.bind).not.toHaveBeenCalled();
    expect(resolver.resolve).toHaveBeenCalledWith({
      tenantId: scope.tenantId,
      registryId: input.registryId,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(router.connect({ ...input, providerKey: "cube" })).rejects.toThrow("绑定不一致");
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("托管配置读取失败时不能退回部署供应商", async () => {
    const { router, resolver, fallback, create } = setup();
    const fallbackCreate = vi.spyOn(fallback.gateway, "create");
    resolver.bind.mockRejectedValue(new Error("配置不可用"));
    await expect(router.prepareCreate({ scope, registryId: "managed-registry" })).rejects.toThrow(
      "配置不可用",
    );
    await expect(
      router.acquire({
        scope,
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      }),
    ).rejects.toThrow("配置不可用");
    expect(create).not.toHaveBeenCalled();
    expect(fallbackCreate).not.toHaveBeenCalled();
  });
  it("预检读取活动供应商池，不再要求未参与分配的环境供应商可达", async () => {
    const { router, registry, fallback } = setup();
    const probe = vi.spyOn(registry, "probe").mockResolvedValue();
    const legacyProbe = vi.spyOn(fallback, "probe").mockRejectedValue(new Error("离线"));
    await router.probe();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(legacyProbe).not.toHaveBeenCalled();
  });
});
