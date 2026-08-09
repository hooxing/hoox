import type { ToolObservationResult } from "@cube-runtime/context-policy";
import type { TodoSnapshot, TodoWriteCommand } from "@cube-runtime/domain";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { createSchemaInvalidArgumentsBridge } from "./tools.js";

const strict = { additionalProperties: false } as const;

export const TodoWriteToolArgumentsSchema = Type.Object(
  {
    explanation: Type.Optional(
      Type.String({
        description: "调整步骤结构或将执行中步骤退回 pending 时说明原因。",
        minLength: 1,
        maxLength: 1_000,
      }),
    ),
    todos: Type.Array(
      Type.Object(
        {
          id: Type.String({
            description: "稳定的步骤 ID；后续更新保持不变。",
            pattern: "^[a-z][a-z0-9_]{0,63}$",
          }),
          content: Type.String({ minLength: 1, maxLength: 240 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        },
        strict,
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  strict,
);
export type TodoWriteToolArguments = Static<typeof TodoWriteToolArgumentsSchema>;

export interface TodoWritePiToolExecutorPort {
  write(input: {
    readonly callId: string;
    readonly command: TodoWriteCommand;
    readonly signal?: AbortSignal;
  }): Promise<TodoSnapshot>;
  projectError(error: unknown): Readonly<{
    status: "failed";
    code: string;
    message: string;
    correctable: boolean;
    fatal: boolean;
  }>;
}

/** Todo 由 Agent 按任务复杂度自主使用，只维护执行清单，不充当其他工具的执行门禁。 */
export function createTodoWritePiTool(
  executor: TodoWritePiToolExecutorPort,
  recordControlledReceipt: (
    callId: string,
    toolName: "todo_write",
    outcome: "succeeded" | "failed",
  ) => Promise<ToolObservationResult>,
  enterReportOnlyMode: () => void = () => undefined,
) {
  const invalidArguments = createSchemaInvalidArgumentsBridge<TodoWriteToolArguments>(
    TodoWriteToolArgumentsSchema,
    (token) => ({
      explanation: token,
      todos: [{ id: "invalid_arguments", content: "参数无效", status: "pending" }],
    }),
    (value) => value.explanation,
  );
  return defineTool({
    name: "todo_write",
    label: "更新任务清单",
    description:
      "复杂或长程任务需要分成多个可验证步骤时，自主创建并持续更新执行清单；简单任务不要使用。首次调用时所有步骤均为 pending；开始步骤时更新为 in_progress，完成后更新为 completed。每次提交完整清单，同时最多一个 in_progress；调整步骤结构时使用 explanation 说明原因。",
    executionMode: "sequential",
    parameters: TodoWriteToolArgumentsSchema,
    prepareArguments: invalidArguments.prepareArguments,
    execute: async (callId, args, signal) => {
      let snapshot: TodoSnapshot | undefined;
      let failure: ReturnType<TodoWritePiToolExecutorPort["projectError"]> | undefined;
      if (invalidArguments.consume(args)) {
        failure = Object.freeze({
          status: "failed" as const,
          code: "TODO_ARGUMENTS_INVALID",
          message: "todo_write 参数无效",
          correctable: true,
          fatal: false,
        });
      } else {
        try {
          snapshot = await executor.write({
            callId,
            command: args,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          failure = executor.projectError(error);
        }
      }
      const observation = await recordControlledReceipt(
        callId,
        "todo_write",
        failure === undefined ? "succeeded" : "failed",
      );
      if (observation.outcome !== "recorded" && observation.outcome !== "replayed") {
        throw new Error("todo_write Tool Observation 未能形成 durable 事实");
      }
      if (failure?.fatal === true) enterReportOnlyMode();
      if (failure !== undefined) throw new Error(JSON.stringify(failure));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
        details: {},
      };
    },
  });
}
