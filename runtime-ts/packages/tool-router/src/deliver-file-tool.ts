import type { ToolObservationResult } from "@hoox/context-policy";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;

export const DeliverFileToolArgumentsSchema = Type.Object(
  {
    path: Type.String({ minLength: 12, maxLength: 4_096 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  },
  strict,
);
export type DeliverFileToolArguments = Static<typeof DeliverFileToolArgumentsSchema>;

export interface DeliverFilePiToolExecutorPort {
  deliverFile(input: {
    readonly callId: string;
    readonly arguments: unknown;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: string;
    message: string;
    correctable: boolean;
    /** 表示该次交付不能原调用重试；失败仍作为 Tool Error 返回模型自行调整。 */
    fatal: boolean;
  }>;
}

/**
 * 交付工具只向模型承诺已经形成可下载交付物；页面如何刷新和展示不属于模型协议。
 */
export function createDeliverFilePiTool(
  router: DeliverFilePiToolExecutorPort,
  recordControlledReceipt: (
    callId: string,
    toolName: "deliver_file",
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
) {
  const invalidArguments = createSchemaInvalidArgumentsBridge<DeliverFileToolArguments>(
    DeliverFileToolArgumentsSchema,
    (token) => ({ path: `/workspace/.runtime-invalid/${token}` }),
    (value) => value.path.slice("/workspace/.runtime-invalid/".length),
  );
  const tool: AgentTool<typeof DeliverFileToolArgumentsSchema, unknown> = {
    name: "deliver_file",
    label: "交付文件",
    description:
      "用户要求生成、导出或提供文件时，在 /workspace 写好最终文件后、回复用户前，调用本工具逐个交付。只写文件或在答复中给出路径不会让用户看到或下载文件。工具返回成功后，用户可从交付卡片打开文件。不要交付临时文件。",
    executionMode: "sequential",
    parameters: DeliverFileToolArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, args, signal) => {
      let result: unknown;
      let failure: ReturnType<DeliverFilePiToolExecutorPort["projectError"]> | undefined;
      if (invalidArguments.consume(args)) {
        failure = Object.freeze({
          status: "failed" as const,
          code: "INVALID_ARGUMENT",
          message: "deliver_file 参数无效",
          correctable: true,
          fatal: false,
        });
      } else {
        try {
          result = await router.deliverFile({
            callId,
            arguments: args,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          failure = router.projectError(error);
        }
      }
      const observation = await recordControlledReceipt(
        callId,
        "deliver_file",
        failure === undefined ? "succeeded" : "failed",
      );
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
        throw new Error("deliver_file Tool Observation 未能形成 durable 事实");
      }
      if (failure !== undefined) throw new Error(JSON.stringify(failure));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {},
      };
    },
  };
  return tool;
}
