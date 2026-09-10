import { createHash } from "node:crypto";
import { resourceId, resourceVersionId, tenantId } from "@hoox/domain";
import type { ResourceFilesystemFile } from "@hoox/resource";
import type { ExecutionScope } from "@hoox/run-contracts";
import { describe, expect, it, vi } from "vitest";
import { ManagedResourceFilesystemSnapshotMaterializer } from "./sandbox-resource-filesystem-materializer.js";

const scope = Object.freeze({
  tenantId: tenantId("tenant-e2b-resourcefs"),
  threadId: "thread-e2b-resourcefs",
  runId: "run-e2b-resourcefs",
  rootRunId: "run-e2b-resourcefs",
  workspaceId: "workspace-e2b-resourcefs",
}) as ExecutionScope;

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function resource(pathName: string, body: Uint8Array): ResourceFilesystemFile {
  const sha256 = digest(body);
  return Object.freeze({
    resourceId: resourceId("resource-e2b"),
    versionId: resourceVersionId("version-e2b"),
    name: pathName,
    path: `/resources/resource-e2b/version-e2b/${pathName}`,
    mediaType: "text/plain",
    sizeBytes: body.byteLength,
    object: Object.freeze({
      tenantId: scope.tenantId,
      purpose: "resource" as const,
      sha256,
      size: body.byteLength,
      mediaType: "text/plain",
      incarnationId: "incarnation-e2b",
      physicalObjectKey: "opaque-e2b-key",
    }),
  });
}

function harness(
  input: {
    readonly maxFiles?: number;
    readonly chunkBytes?: number;
    readonly writeAttempts?: number;
    readonly writeConcurrency?: number;
    readonly writeAttemptTimeoutMs?: number;
  } = {},
) {
  const resourceBody = new TextEncoder().encode("resource-body");
  const skillBody = new TextEncoder().encode("skill-body");
  const writes: { path: string; body: Uint8Array }[] = [];
  const commands: string[] = [];
  const materializer = new ManagedResourceFilesystemSnapshotMaterializer(
    {
      resources: {
        list: async () => [resource("资料.txt", resourceBody)],
        resolve: async () => undefined,
      },
      history: {
        listRecentDirectories: async () => [
          {
            threadId: scope.threadId,
            name: "2026-08-14_测试任务",
            createdAt: "2026-08-14T00:00:00.000Z",
            lastFileAt: "2026-08-14T00:00:00.000Z",
            fileCount: 1,
          },
        ],
        listThreadIds: async () => [scope.threadId],
        resolveDirectory: async () => undefined,
        listThreadFiles: async () => [
          {
            ...resource("资料.txt", resourceBody),
            threadId: scope.threadId,
            directoryName: "2026-08-14_测试任务",
            entryName: "资料.txt",
          },
        ],
        resolveHistoryFile: async () => undefined,
        resolveThreadFile: async () => undefined,
      },
      blobs: {
        getBytes: async () => resourceBody,
      } as never,
      skills: {
        listDirectory: async ({ segments }) => {
          if (segments.length === 0) return [{ kind: "directory" as const, name: "demo" }];
          if (segments.join("/") === "demo") {
            return [
              {
                kind: "file" as const,
                name: "SKILL.md",
                mediaType: "text/markdown",
                sizeBytes: skillBody.byteLength,
                contentDigest: digest(skillBody),
              },
            ];
          }
          return undefined;
        },
        resolveFile: async () => ({
          mediaType: "text/markdown",
          sizeBytes: skillBody.byteLength,
          contentDigest: digest(skillBody),
          source: { kind: "inline" as const, body: skillBody },
        }),
      },
      skillContents: { read: async () => skillBody },
    },
    input,
  );
  const sandbox = {
    id: "sandbox-e2b-resourcefs",
    command: vi.fn(async (command: string) => {
      commands.push(command);
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    runCode: async () => ({ stdout: [], stderr: [] }),
    readFile: async () => "",
    writeFile: vi.fn(async (path: string, body: string | Uint8Array) => {
      writes.push({
        path,
        body: typeof body === "string" ? new TextEncoder().encode(body) : body,
      });
    }),
    pause: async () => undefined,
    kill: async () => undefined,
  };
  return { materializer, sandbox, writes, commands };
}

describe("E2B ResourceFS 受控快照物化", () => {
  it("物化 Resource、history、Thread 稳定入口和公开 Skill，且不把存储凭据写入 Sandbox", async () => {
    const h = harness();
    await h.materializer.materialize({
      scope,
      sandbox: h.sandbox,
      signal: new AbortController().signal,
    });

    const paths = h.writes.map((item) => item.path);
    expect(paths.some((path) => path.endsWith("/resource-e2b/version-e2b/资料.txt"))).toBe(true);
    expect(paths.some((path) => path.endsWith("/history/2026-08-14_测试任务/资料.txt"))).toBe(true);
    expect(
      paths.some((path) => path.endsWith("/.thread-files/thread-e2b-resourcefs/files/资料.txt")),
    ).toBe(true);
    expect(paths.some((path) => path.endsWith("/skills/demo/SKILL.md"))).toBe(true);
    expect(h.commands.join("\n")).toContain("sha256sum");
    expect(h.commands.join("\n")).toContain("chown -R root:root");
    expect(h.commands.join("\n")).toContain("ensure_root_link /history '/resources/history'");
    expect(h.commands.join("\n")).toContain(
      "ensure_root_link /thread-files '/resources/.thread-files/thread-e2b-resourcefs/files'",
    );
    expect(JSON.stringify({ paths, commands: h.commands })).not.toContain("opaque-e2b-key");
  });

  it("大文件拆成有界分块写入，再在远端合并为最终路径", async () => {
    const h = harness({ chunkBytes: 4, writeConcurrency: 1, writeAttempts: 1 });
    await h.materializer.materialize({
      scope,
      sandbox: h.sandbox,
      signal: new AbortController().signal,
    });

    const writes = h.writes.filter((item) => item.path.includes(".hooxpart-"));
    expect(writes.length).toBeGreaterThan(0);
    const resourceParts = writes
      .filter((item) => item.path.includes("/resource-e2b/version-e2b/资料.txt.hooxpart-"))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(resourceParts.length).toBe(Math.ceil(13 / 4));
    const assembled = Buffer.concat(resourceParts.map((item) => Buffer.from(item.body))).toString();
    expect(assembled).toBe("resource-body");
    // 最终路径只能由远端合并产生，不能由一次大请求直接写出。
    expect(h.writes.some((item) => item.path.endsWith("/version-e2b/资料.txt"))).toBe(false);
    expect(h.commands.join("\n")).toContain("cat ");
    expect(h.commands.join("\n")).toContain("rm -f ");
  });

  it("写入瞬时失败会重试并最终成功", async () => {
    const h = harness({ writeAttempts: 3, writeConcurrency: 1 });
    const inner = h.sandbox.writeFile.getMockImplementation();
    if (inner === undefined) throw new Error("测试夹具缺少 writeFile 实现");
    let failedOnce = false;
    h.sandbox.writeFile.mockImplementation(async (path: string, body: string | Uint8Array) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("数据面停顿");
      }
      return inner(path, body);
    });

    await h.materializer.materialize({
      scope,
      sandbox: h.sandbox,
      signal: new AbortController().signal,
    });

    expect(failedOnce).toBe(true);
    expect(h.sandbox.writeFile.mock.calls.length).toBeGreaterThan(h.writes.length);
  });

  it("写入重试耗尽后失败关闭并清理 staging", async () => {
    const h = harness({ writeAttempts: 2, writeConcurrency: 1, chunkBytes: 16 });
    h.sandbox.writeFile.mockRejectedValue(new Error("数据面停顿"));

    await expect(
      h.materializer.materialize({
        scope,
        sandbox: h.sandbox,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("数据面停顿");

    // 16、4、1 字节三档，每档两次尝试；全部失败才关闭。
    expect(h.sandbox.writeFile).toHaveBeenCalledTimes(6);
    expect(h.commands.join("\n")).toContain("rm -rf --");
  });

  it("大分块停摆后自动降级到更小分块并成功", async () => {
    const h = harness({ writeAttempts: 1, writeConcurrency: 1, chunkBytes: 8 });
    const inner = h.sandbox.writeFile.getMockImplementation();
    if (inner === undefined) throw new Error("测试夹具缺少 writeFile 实现");
    const stalled: string[] = [];
    h.sandbox.writeFile.mockImplementation(async (path: string, body: string | Uint8Array) => {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      // 只让 8 字节档位停摆，模拟大请求体被链路静默丢弃。
      if (bytes.byteLength === 8) {
        stalled.push(path);
        throw new Error("数据面停顿");
      }
      return inner(path, body);
    });

    await h.materializer.materialize({
      scope,
      sandbox: h.sandbox,
      signal: new AbortController().signal,
    });

    expect(stalled.length).toBeGreaterThan(0);
    const written = h.writes.filter((item) => item.path.includes("/version-e2b/资料.txt"));
    const parts = written
      .filter((item) => item.path.includes(".hooxpart-"))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.concat(parts.map((item) => Buffer.from(item.body))).toString()).toBe(
      "resource-body",
    );
    expect(h.commands.join("\n")).toContain("cat ");
  });

  it("超过快照文件上限时在写远端前失败关闭", async () => {
    const h = harness({ maxFiles: 1 });
    await expect(
      h.materializer.materialize({
        scope,
        sandbox: h.sandbox,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("文件数量超过上限");
    expect(h.sandbox.writeFile).not.toHaveBeenCalled();
  });
});
