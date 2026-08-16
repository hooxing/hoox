import { tenantId, userId } from "@aisay/domain";
import { describe, expect, it, vi } from "vitest";
import { HistoryFileLibraryService, type HistoryFileLibraryCatalog } from "./history-library.js";

const context = { tenantId: tenantId("tenant-history"), userId: userId("user-history") };

describe("历史文件目录服务", () => {
  it("默认只读取当前时间前六个月并保留按任务分页", async () => {
    const listTaskPage = vi.fn<HistoryFileLibraryCatalog["listTaskPage"]>(async (input) => ({
      items: [],
      range: { ...(input.activeAfter === undefined ? {} : { activeAfter: input.activeAfter }) },
      hasMore: false,
      hasOlder: true,
    }));
    const service = new HistoryFileLibraryService(
      { listTaskPage, resolveLibraryFile: vi.fn(async () => undefined) },
      () => new Date("2026-08-07T12:00:00.000Z"),
    );

    await expect(service.list({ context, query: "  合同   审查  " })).resolves.toMatchObject({
      range: { activeAfter: "2026-02-07T12:00:00.000Z" },
      hasOlder: true,
    });
    expect(listTaskPage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        query: "合同 审查",
        activeAfter: "2026-02-07T12:00:00.000Z",
        limit: 24,
      }),
    );
  });

  it("加载更早任务时使用 activeBefore 且不重新套用六个月下界", async () => {
    const listTaskPage = vi.fn<HistoryFileLibraryCatalog["listTaskPage"]>(async (input) => ({
      items: [],
      range: { ...(input.activeBefore === undefined ? {} : { activeBefore: input.activeBefore }) },
      hasMore: false,
      hasOlder: false,
    }));
    const service = new HistoryFileLibraryService(
      { listTaskPage, resolveLibraryFile: vi.fn(async () => undefined) },
      () => new Date("2026-08-07T12:00:00.000Z"),
    );

    await service.list({ context, activeBefore: "2026-02-07T12:00:00.000Z" });
    expect(listTaskPage).toHaveBeenCalledWith(
      expect.not.objectContaining({ activeAfter: expect.anything() }),
    );
  });

  it("下载只接受已存在于个人历史关系中的稳定文件", async () => {
    const file = {
      threadId: "thread-history",
      taskName: "合同审查",
      resourceId: "resource-history",
      versionId: "version-history",
      name: "合同.docx",
      entryName: "合同.docx",
      path: "/resources/resource-history/version-history/合同.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 128,
      attachedAt: "2026-08-07T10:00:00.000Z",
      object: {
        tenantId: "tenant-history",
        purpose: "resource" as const,
        sha256: "a".repeat(64),
        size: 128,
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        incarnationId: "00000000-0000-4000-8000-000000000001",
        physicalObjectKey: "opaque",
      },
    };
    const resolveLibraryFile = vi.fn<HistoryFileLibraryCatalog["resolveLibraryFile"]>(
      async () => file,
    );
    const service = new HistoryFileLibraryService({
      listTaskPage: vi.fn(async () => undefined),
      resolveLibraryFile,
    });

    await expect(
      service.resolve({ context, resourceId: file.resourceId, versionId: file.versionId }),
    ).resolves.toBe(file);
    expect(resolveLibraryFile).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      resourceId: file.resourceId,
      versionId: file.versionId,
    });
  });
});
