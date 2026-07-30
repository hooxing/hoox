import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelWireTracePort, ModelWireTraceRecord } from "./model-wire-trace.js";
import {
  ProjectModelWireTraceMirror,
  withDevelopmentProjectModelWireTraceMirror,
} from "./project-model-wire-trace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("测试临时目录越界");
    await rm(root, { recursive: true, force: true });
  }
});

describe("项目模型报文本地镜像", () => {
  it("按已校验 Run/Attempt 与明确 part/status 的稳定文件名保存原始字节", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const request = record({
      part: "request",
      status: "complete",
      body: new TextEncoder().encode('{ "message": "甲" }'),
    });
    const response = record({
      part: "response",
      status: "truncated",
      body: new TextEncoder().encode('data: {"delta":"乙"}\n\n'),
    });

    await mirror.persist(request);
    await mirror.persist(response);

    const directory = join(root, "run_dev_1", "attempt_dev_1");
    expect(await readdir(directory)).toEqual([
      "model-turn-03-transport-2-request-complete.json",
      "model-turn-03-transport-2-response-truncated.sse",
    ]);
    expect(
      await readFile(join(directory, "model-turn-03-transport-2-request-complete.json"), "utf8"),
    ).toBe('{ "message": "甲" }');
    expect(
      await readFile(join(directory, "model-turn-03-transport-2-response-truncated.sse"), "utf8"),
    ).toBe('data: {"delta":"乙"}\n\n');
  });

  it("相同正文幂等重放，不同正文拒绝覆盖且不留下半文件", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const first = record({ body: new TextEncoder().encode('{"first":true}') });
    await mirror.persist(first);
    await mirror.persist(first);

    await expect(
      mirror.persist(record({ body: new TextEncoder().encode('{"second":true}') })),
    ).rejects.toThrow("LOCAL_MODEL_WIRE_TRACE_CONFLICT");

    const directory = join(root, "run_dev_1", "attempt_dev_1");
    const files = await readdir(directory);
    expect(files).toEqual(["model-turn-03-transport-2-request-complete.json"]);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await readFile(join(directory, files[0] as string), "utf8")).toBe('{"first":true}');
  });

  it("镜像失败不影响权威持久化，production 不创建本地镜像", async () => {
    const authoritativePersist = vi.fn(async () => undefined);
    const authoritativeCaptureFailed = vi.fn(async () => undefined);
    const authoritative: ModelWireTracePort = {
      persist: authoritativePersist,
      captureFailed: authoritativeCaptureFailed,
    };
    const mirrorFactory = vi.fn(
      (): ModelWireTracePort => ({
        persist: async () => Promise.reject(new Error("磁盘只读")),
        captureFailed: async () => undefined,
      }),
    );
    const development = withDevelopmentProjectModelWireTraceMirror(
      "development",
      authoritative,
      mirrorFactory,
    );

    await expect(development.persist(record())).resolves.toBeUndefined();
    expect(authoritativePersist).toHaveBeenCalledOnce();
    expect(mirrorFactory).toHaveBeenCalledOnce();

    const productionMirrorFactory = vi.fn(
      (): ModelWireTracePort => ({
        persist: async () => undefined,
        captureFailed: async () => undefined,
      }),
    );
    const production = withDevelopmentProjectModelWireTraceMirror(
      "production",
      authoritative,
      productionMirrorFactory,
    );
    expect(production).toBe(authoritative);
    expect(productionMirrorFactory).not.toHaveBeenCalled();
  });

  it("拒绝能逃逸固定根目录的未校验上下文", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const invalid = {
      ...record(),
      context: {
        tenantId: "tenant_dev",
        threadId: "thread_dev",
        runId: "../escape",
        attemptId: "a",
      },
    };
    await expect(mirror.persist(invalid)).rejects.toThrow("模型网络诊断作用域无效");
    await expect(readdir(root)).resolves.toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cube-model-wire-traces-"));
  temporaryRoots.push(root);
  return root;
}

function record(
  input: Partial<Pick<ModelWireTraceRecord, "part" | "status" | "body">> = {},
): ModelWireTraceRecord {
  const body = input.body ?? new TextEncoder().encode('{"ok":true}');
  return {
    context: {
      tenantId: "tenant_dev_1",
      threadId: "thread_dev_1",
      runId: "run_dev_1",
      attemptId: "attempt_dev_1",
    },
    modelTurn: 3,
    transportAttempt: 2,
    part: input.part ?? "request",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
    status: input.status ?? "complete",
  };
}
