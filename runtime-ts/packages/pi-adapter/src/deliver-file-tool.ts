import type { ToolObservationResult } from "@cube-runtime/context-policy";
import { defineTool } from "@earendil-works/pi-coding-agent";
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
    /** 必须在 durable 失败回执后关闭后续 Provider，不能让模型当作普通可修正错误继续。 */
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
  rejectModelContinuation: () => void = () => undefined,
) {
  const invalidArguments = createSchemaInvalidArgumentsBridge<DeliverFileToolArguments>(
    DeliverFileToolArgumentsSchema,
    (token) => ({ path: `/workspace/.runtime-invalid/${token}` }),
    (value) => value.path.slice("/workspace/.runtime-invalid/".length),
  );
  return defineTool({
    name: "deliver_file",
    label: "交付文件",
    description:
      "将 CubeSandbox 中已经生成的文件作为本次任务的交付文件提供给用户。仅当文件已成功保存为可下载交付物时返回成功。",
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
      if (failure?.fatal === true) rejectModelContinuation();
      if (failure !== undefined) throw new Error(JSON.stringify(failure));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
}
