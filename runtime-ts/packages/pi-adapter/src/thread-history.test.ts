import { describe, expect, it } from "vitest";
import {
  assertThreadActiveHistory,
  threadActiveHistoryDigest,
  type ThreadActiveHistoryV1,
} from "./thread-history.js";

describe("Thread Active History 协议", () => {
  it("工具调用与结果必须成对且中间不得插入其他角色", () => {
    const unsigned = {
      schemaVersion: 1 as const,
      projectionSchemaVersion: 1 as const,
      throughSequence: 3,
      messages: [
        {
          sequence: 1,
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "call-a",
              name: "exec_command",
              arguments: { cmd: "pwd" },
            },
          ],
          api: "faux",
          provider: "faux",
          model: "faux",
          stopReason: "toolUse" as const,
          timestamp: 1,
        },
        { sequence: 2, role: "user" as const, text: "非法插入", timestamp: 2 },
        {
          sequence: 3,
          role: "toolResult" as const,
          toolCallId: "call-a",
          toolName: "exec_command",
          text: "/workspace",
          isError: false,
          timestamp: 3,
        },
      ],
    };
    const history: ThreadActiveHistoryV1 = {
      ...unsigned,
      digest: threadActiveHistoryDigest(unsigned),
    };
    expect(() => assertThreadActiveHistory(history)).toThrow(
      "Thread tool call/result 之间出现非法消息",
    );
  });
});
