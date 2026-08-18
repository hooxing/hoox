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

function harness(input: { readonly maxFiles?: number } = {}) {
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
