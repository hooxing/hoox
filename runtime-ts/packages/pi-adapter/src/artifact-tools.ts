import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ToolObservationResult } from "@hoox/context-policy";

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 3, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]+$" });
const idempotencyKey = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const safeName = Type.String({ minLength: 1, maxLength: 255 });

/** 模型可见协议只含业务字段，不接受 scope、栅栏、对象键、请求头或下载 URL。 */
export const DeclareDeliverablesToolArgumentsSchema = Type.Object(
  {
    idempotencyKey,
    declarations: Type.Array(
      Type.Object(
        {
          key: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
          }),
          name: safeName,
          requirement: Type.Union([Type.Literal("required"), Type.Literal("optional")]),
        },
        strict,
      ),
      { maxItems: 64 },
    ),
  },
  strict,
);
export type DeclareDeliverablesToolArguments = Static<
  typeof DeclareDeliverablesToolArgumentsSchema
>;

export const PublishArtifactToolArgumentsSchema = Type.Object(
  {
    idempotencyKey,
    artifactId: id,
    replacesArtifactId: Type.Optional(id),
    name: safeName,
    purpose: Type.Union([
      Type.Literal("deliverable"),
      Type.Literal("diagnostic"),
      Type.Literal("trace"),
    ]),
    deliverableKey: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      }),
    ),
    source: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("workspace_file"),
          relativePath: Type.String({ minLength: 1, maxLength: 1024 }),
          resourceName: safeName,
        },
        strict,
      ),
      Type.Object(
        {
          kind: Type.Literal("resource_version"),
          resourceVersionId: id,
        },
        strict,
      ),
    ]),
  },
  strict,
);
export type PublishArtifactToolArguments = Static<typeof PublishArtifactToolArgumentsSchema>;

export const PI_ARTIFACT_TOOL_NAMES = ["declare_deliverables", "publish_artifact"] as const;

export interface ArtifactPiToolExecutorPort {
  declareDeliverables(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  publishArtifact(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  /** Tool Router 负责把所有内部异常投影成不含 cause 的稳定公开结构。 */
  projectError(error: unknown): Readonly<{
    ok: false;
    code: string;
    message: string;
    correctable: boolean;
  }>;
}

/** Pi 只负责工具循环；参数校验、许可消费、业务错误和审计边界全部留在 Tool Router。 */
export function createArtifactPiTools(
  router: ArtifactPiToolExecutorPort,
  recordControlledReceipt: (
    callId: string,
    toolName: (typeof PI_ARTIFACT_TOOL_NAMES)[number],
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
) {
  return [
    defineTool({
      name: "declare_deliverables",
      label: "声明交付物",
      description: "声明本次 Run 必需和可选的最终交付物；必需项未发布时 Run 不能成功。",
      executionMode: "sequential",
      parameters: DeclareDeliverablesToolArgumentsSchema,
      execute: async (callId, args, signal) =>
        artifactToolResult(
          callId,
          "declare_deliverables",
          () =>
            router.declareDeliverables({
              callId,
              arguments: args,
              ...(signal === undefined ? {} : { signal }),
            }),
          router,
          recordControlledReceipt,
        ),
    }),
    defineTool({
      name: "publish_artifact",
      label: "发布交付物",
      description:
        "接受安全 Workspace 相对路径的发布意图，最终 Revision 提交时原子发布；已固定 ResourceVersion 可直接发布。",
      executionMode: "sequential",
      parameters: PublishArtifactToolArgumentsSchema,
      execute: async (callId, args, signal) =>
        artifactToolResult(
          callId,
          "publish_artifact",
          () =>
            router.publishArtifact({
              callId,
              arguments: args,
              ...(signal === undefined ? {} : { signal }),
            }),
          router,
          recordControlledReceipt,
        ),
    }),
  ];
}

async function artifactToolResult(
  callId: string,
  toolName: (typeof PI_ARTIFACT_TOOL_NAMES)[number],
  action: () => Promise<unknown>,
  projector: Pick<ArtifactPiToolExecutorPort, "projectError">,
  recordControlledReceipt: (
    callId: string,
    toolName: (typeof PI_ARTIFACT_TOOL_NAMES)[number],
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
) {
  let outcome: "succeeded" | "failed" = "succeeded";
  try {
    await action();
  } catch (error) {
    // 只记录稳定投影码；Artifact 原始结果、参数和错误正文都不进入模型或开发日志。
    const projected = projector.projectError(error);
    if (process.env.RUNTIME_ENV === "development") {
      console.warn(`ARTIFACT_TOOL_FAILED tool=${toolName} code=${projected.code}`);
    }
    outcome = "failed";
  }
  const observation = await recordControlledReceipt(callId, toolName, outcome);
  if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
    throw new Error("Artifact Tool Observation 未能形成 durable 事实");
  }
  if (outcome === "failed") {
    // Pi 只把异常执行标为 tool error；异常正文仍是已经持久化的固定受控回执。
    throw new Error(observation.observation);
  }
  return {
    content: [{ type: "text" as const, text: observation.observation }],
    details: {},
  };
}
