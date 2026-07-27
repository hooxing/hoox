import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

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
export function createArtifactPiTools(router: ArtifactPiToolExecutorPort) {
  return [
    defineTool({
      name: "declare_deliverables",
      label: "声明交付物",
      description: "声明本次 Run 必需和可选的最终交付物；必需项未发布时 Run 不能成功。",
      parameters: DeclareDeliverablesToolArgumentsSchema,
      execute: async (callId, args, signal) =>
        artifactToolResult(
          () =>
            router.declareDeliverables({
              callId,
              arguments: args,
              ...(signal === undefined ? {} : { signal }),
            }),
          router,
        ),
    }),
    defineTool({
      name: "publish_artifact",
      label: "发布交付物",
      description:
        "从安全 Workspace 相对路径或已固定 ResourceVersion 发布不可变 Artifact；失败修正必须使用新版本和新 Artifact。",
      parameters: PublishArtifactToolArgumentsSchema,
      execute: async (callId, args, signal) =>
        artifactToolResult(
          () =>
            router.publishArtifact({
              callId,
              arguments: args,
              ...(signal === undefined ? {} : { signal }),
            }),
          router,
        ),
    }),
  ];
}

async function artifactToolResult(
  action: () => Promise<unknown>,
  projector: Pick<ArtifactPiToolExecutorPort, "projectError">,
) {
  try {
    const result = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: {},
    };
  } catch (error) {
    // 投影只含稳定码、可修正性和公开消息；对象键、签名 URL 与依赖 cause 不进入模型上下文。
    // Pi 0.82.1 不读取自定义 ToolResult 的 isError 字段；抛出仅含安全 JSON 的新错误，
    // 由 Pi 生成 isError=true 的 toolResult，不能把原始 cause 直接抛回模型。
    throw new Error(JSON.stringify(projector.projectError(error)));
  }
}
