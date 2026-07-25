import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ArtifactDtoSchema,
  createNotFoundEnvelope,
  ErrorEnvelopeSchema,
  eventEnvelopeSchema,
  IdSchema,
  MembershipDtoSchema,
  publicErrorCodes,
  ResourceVersionDtoSchema,
  RunDtoSchema,
  successEnvelopeSchema,
  TenantDtoSchema,
  ThreadDtoSchema,
  UserDtoSchema,
  WorkspaceRevisionDtoSchema,
} from "../../runtime-ts/packages/protocol/src/index.js";

const timestamp = "2026-07-26T00:00:00.000Z";

describe("协议 Schema", () => {
  it("DTO 可以完成 JSON 序列化往返", () => {
    const dto = {
      id: "run_roundtrip",
      tenantId: "tenant_one",
      threadId: "thread_one",
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(Value.Check(RunDtoSchema, dto)).toBe(true);
    const restored: unknown = JSON.parse(JSON.stringify(dto));
    expect(Value.Check(RunDtoSchema, restored)).toBe(true);
    expect(restored).toEqual(dto);
  });

  it("严格拒绝未声明字段和非法状态", () => {
    const base = {
      id: "thread_one",
      tenantId: "tenant_one",
      createdByUserId: "user_one",
      title: "测试任务",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(Value.Check(ThreadDtoSchema, { ...base, hidden: "value" })).toBe(false);
    expect(
      Value.Check(RunDtoSchema, {
        id: "run_invalid",
        tenantId: "tenant_one",
        threadId: "thread_one",
        status: "unknown",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toBe(false);
  });

  it("成功与事件信封复用同一协议版本", () => {
    const successSchema = successEnvelopeSchema(RunDtoSchema);
    const eventSchema = eventEnvelopeSchema("run.status_changed", RunDtoSchema);
    const run = {
      id: "run_event",
      tenantId: "tenant_one",
      threadId: "thread_one",
      status: "waiting",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(Value.Check(successSchema, { version: "v1", requestId: "request_one", data: run })).toBe(
      true,
    );
    expect(
      Value.Check(eventSchema, {
        version: "v1",
        eventId: "event_one",
        sequence: 1,
        occurredAt: timestamp,
        type: "run.status_changed",
        payload: run,
      }),
    ).toBe(true);
  });

  it("公开错误码稳定且越权与不存在共用安全信封", () => {
    expect(new Set(publicErrorCodes).size).toBe(publicErrorCodes.length);
    const envelope = createNotFoundEnvelope("request_hidden");
    expect(Value.Check(ErrorEnvelopeSchema, envelope)).toBe(true);
    expect(envelope.error).toEqual({
      code: "NOT_FOUND",
      message: "请求的资源不存在",
      retryable: false,
    });
    expect(JSON.stringify(envelope)).not.toContain("tenant");
    expect(() => createNotFoundEnvelope("x")).toThrow("requestId 格式无效");
  });

  const strictDtoCases = [
    [UserDtoSchema, { id: "user_one", createdAt: timestamp }],
    [
      TenantDtoSchema,
      {
        id: "tenant_one",
        kind: "personal",
        ownerUserId: "user_one",
        createdAt: timestamp,
      },
    ],
    [
      MembershipDtoSchema,
      {
        id: "membership_one",
        tenantId: "tenant_one",
        userId: "user_one",
        role: "owner",
        status: "active",
        createdAt: timestamp,
      },
    ],
    [
      ThreadDtoSchema,
      {
        id: "thread_one",
        tenantId: "tenant_one",
        createdByUserId: "user_one",
        title: "任务",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    [
      RunDtoSchema,
      {
        id: "run_one",
        tenantId: "tenant_one",
        threadId: "thread_one",
        status: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    [
      WorkspaceRevisionDtoSchema,
      {
        id: "workspace_revision_one",
        workspaceId: "workspace_one",
        tenantId: "tenant_one",
        threadId: "thread_one",
        revisionNumber: 1,
        createdByRunId: "run_one",
        leaseEpoch: 1,
        objectKey: "workspace/one.tar",
        digest: "a".repeat(64),
        createdAt: timestamp,
      },
    ],
    [
      ResourceVersionDtoSchema,
      {
        id: "resource_version_one",
        resourceId: "resource_one",
        tenantId: "tenant_one",
        versionNumber: 1,
        objectKey: "resource/one",
        digest: "a".repeat(64),
        mediaType: "text/plain",
        sizeBytes: 1,
        createdAt: timestamp,
      },
    ],
    [
      ArtifactDtoSchema,
      {
        id: "artifact_one",
        tenantId: "tenant_one",
        threadId: "thread_one",
        runId: "run_one",
        resourceVersionId: "resource_version_one",
        name: "交付物",
        status: "published",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  ] as const;

  it.each(strictDtoCases)("所有 DTO 都拒绝额外字段 %#", (schema, value) => {
    expect(Value.Check(schema, value)).toBe(true);
    expect(Value.Check(schema, { ...value, unexpected: "不可接受" })).toBe(false);
  });

  it("品牌 ID 的运行时格式与领域格式保持同一公开契约", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/u), (value) => {
        expect(Value.Check(IdSchema, value)).toBe(true);
      }),
    );
    for (const invalid of ["", "ab", "has space", "slash/value"]) {
      expect(Value.Check(IdSchema, invalid)).toBe(false);
    }
  });
});
