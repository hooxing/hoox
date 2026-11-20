import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertRunSkillSnapshot,
  digestRunSkillSnapshot,
  resolveExplicitSkillInvocation,
  type SkillExecutionBinding,
  type SkillInvocationTarget,
  SkillRuntimeError,
  type SkillRuntimeRepository,
  SkillRuntimeService,
} from "./runtime.js";

const binding: SkillExecutionBinding = Object.freeze({
  tenantId: "tenant-1",
  threadId: "thread-1",
  runId: "run-1",
  rootRunId: "run-1",
  workspaceId: "workspace-1",
  attemptId: "attempt-1",
  runClaimToken: "claim-1",
  runClaimEpoch: 1,
  workspaceLeaseRootRunId: "run-1",
  workspaceLeaseEpoch: 1,
});

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const instruction = new TextEncoder().encode("# Review\n\n按清单检查修改。\n");
  const resource = new TextEncoder().encode("check-a\ncheck-b\n");
  const target: SkillInvocationTarget = {
    invocationId: "tool:call-1",
    invocationName: "review",
    canonicalKey: "code-review",
    skillVersion: "1.2.3",
    entrypointDigest: sha(instruction),
    entrypointSizeBytes: instruction.byteLength,
    entrypointBlobRef: "entrypoint-ref",
    packageDigest: "a".repeat(64),
    files: [
      {
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: instruction.byteLength,
        contentDigest: sha(instruction),
        blobRef: "entrypoint-ref",
      },
      {
        path: "references/checklist.txt",
        mediaType: "text/plain",
        sizeBytes: resource.byteLength,
        contentDigest: sha(resource),
        blobRef: "resource-ref",
      },
    ],
  };
  const completeInvocation = vi.fn(async () => undefined);
  const listLoadedPackages = vi.fn(async () => [target]);
  const repository: SkillRuntimeRepository = {
    beginInvocation: vi.fn(async () => target),
    completeInvocation,
    listLoadedPackages,
  };
  const read = vi.fn(async ({ blobRef }: { readonly blobRef: string }) =>
    blobRef === "entrypoint-ref" ? instruction : resource,
  );
  return {
    service: new SkillRuntimeService(repository, { read }),
    repository,
    read,
    completeInvocation,
    listLoadedPackages,
    instruction,
    resource,
    target,
  };
}

describe("Skill Runtime", () => {
  it("显式或工具加载只读取后端内容并返回固定版本指令，不触碰 Sandbox target", async () => {
    const value = fixture();
    const instruction = await value.service.loadInstruction({
      binding,
      source: "tool",
      callId: "call-1",
      invocationName: "review",
      args: "检查当前修改",
    });

    expect(instruction.modelText).toContain(
      '[RUNTIME_SKILL_INSTRUCTION schema=1 name="review" version="1.2.3"',
    );
    expect(instruction.modelText).toContain("按清单检查修改");
    expect(instruction.packageRoot).toBe("/resources/skills/code-review/1.2.3");
    expect(value.read).toHaveBeenCalledTimes(1);
    expect(value.completeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "loaded", invocationId: "tool:call-1" }),
    );
  });

  it("指令加载只读取入口文件，包内资源由全局虚拟目录按需提供", async () => {
    const value = fixture();

    const instruction = await value.service.loadInstruction({
      binding,
      source: "tool",
      callId: "call-1",
      invocationName: "review",
    });

    expect(instruction.resources).toEqual([
      expect.objectContaining({ path: "references/checklist.txt" }),
    ]);
    expect(value.read).toHaveBeenCalledTimes(1);
    expect(value.read).toHaveBeenCalledWith(expect.objectContaining({ blobRef: "entrypoint-ref" }));
  });

  it("加载指令前拒绝路径穿越等非法包元数据", async () => {
    const value = fixture();
    vi.mocked(value.repository.beginInvocation).mockResolvedValueOnce({
      ...value.target,
      files: [
        ...value.target.files,
        {
          path: "references/../escape.txt",
          mediaType: "text/plain",
          sizeBytes: 0,
          contentDigest: sha(""),
          blobRef: "escape-ref",
        },
      ],
    });

    await expect(
      value.service.loadInstruction({
        binding,
        source: "tool",
        callId: "call-1",
        invocationName: "review",
      }),
    ).rejects.toEqual(new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE"));
    expect(value.read).not.toHaveBeenCalled();
  });

  it("Session 重建从 durable loaded invocation 重读同一版本正文", async () => {
    const value = fixture();

    const recovered = await value.service.recoverLoadedInstructions({ binding });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ name: "review", version: "1.2.3", args: "" });
    expect(recovered[0]?.modelText).toContain("按清单检查修改");
    expect(value.repository.beginInvocation).not.toHaveBeenCalled();
    expect(value.completeInvocation).not.toHaveBeenCalled();
  });

  it("同时提交 Slash 与结构化调用时拒绝歧义", () => {
    expect(() =>
      resolveExplicitSkillInvocation({
        inputText: "/review 检查修改",
        structured: { skill: "review", args: "检查修改" },
      }),
    ).toThrowError(expect.objectContaining({ code: "SKILL_ARGUMENTS_INVALID" }));
    expect(resolveExplicitSkillInvocation({ inputText: "/review 检查修改" })).toEqual({
      invocationName: "review",
      args: "检查修改",
    });
  });

  it("Blob 摘要不匹配时失败关闭并记录稳定失败", async () => {
    const value = fixture();
    value.read.mockResolvedValueOnce(new TextEncoder().encode("tampered"));

    await expect(
      value.service.loadInstruction({
        binding,
        source: "tool",
        callId: "call-1",
        invocationName: "review",
      }),
    ).rejects.toEqual(new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE"));
    expect(value.completeInvocation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "failed",
        failureCode: "SKILL_CONTENT_UNAVAILABLE",
      }),
    );
  });

  it("loaded 持久化结果未知时升级为协议错误，不能降级成可重试的内容失败", async () => {
    const value = fixture();
    value.completeInvocation.mockRejectedValueOnce(new Error("commit unknown"));

    await expect(
      value.service.loadInstruction({
        binding,
        source: "tool",
        callId: "call-1",
        invocationName: "review",
      }),
    ).rejects.toEqual(new SkillRuntimeError("SKILL_PROTOCOL"));
    expect(value.completeInvocation).toHaveBeenCalledTimes(1);
    expect(value.completeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "loaded" }),
    );
  });

  it("Run 快照摘要由目录与显式参数确定，篡改后拒绝进入 Session", () => {
    const items = [
      {
        source: "tenant" as const,
        invocationName: "review",
        canonicalKey: "code-review",
        skillVersion: "1.2.3",
        description: "审阅修改",
        entrypointDigest: "a".repeat(64),
        packageDigest: "b".repeat(64),
      },
    ];
    const explicitInvocation = { invocationName: "review", args: "检查安全性" };
    const snapshot = {
      schemaVersion: 1 as const,
      digest: digestRunSkillSnapshot({ items, explicitInvocation }),
      items,
      explicitInvocation,
    };

    const legacyItems = items.map(({ source: _, ...item }) => item);
    const legacyDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: 1,
          items: legacyItems,
          explicit: {
            invocationName: explicitInvocation.invocationName,
            argsDigest: createHash("sha256").update(explicitInvocation.args).digest("hex"),
          },
        }),
      )
      .digest("hex");
    expect(snapshot.digest).toBe(legacyDigest);
    expect(() => assertRunSkillSnapshot(snapshot)).not.toThrow();
    expect(() =>
      assertRunSkillSnapshot({
        ...snapshot,
        items: items.map((item) => ({ ...item, source: "agent" })),
      }),
    ).toThrow(/摘要不匹配/u);
    expect(() =>
      assertRunSkillSnapshot({
        ...snapshot,
        explicitInvocation: { ...explicitInvocation, args: "检查性能" },
      }),
    ).toThrow(/摘要不匹配/u);
  });
});
