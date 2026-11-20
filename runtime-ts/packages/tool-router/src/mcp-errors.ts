export type McpResponseFailureCode = "MCP_PROTOCOL_ERROR" | "MCP_TOOL_ERROR";
const MESSAGES: Record<McpResponseFailureCode, string> = {
  MCP_PROTOCOL_ERROR: "远程 MCP 服务未能完成请求。",
  MCP_TOOL_ERROR: "远程 MCP 工具执行失败。",
};

/** 仅用于服务端明确返回的 JSON-RPC/工具失败；未知响应和断连不得使用。 */
export class McpResponseFailure extends Error {
  override readonly name = "McpResponseFailure";
  readonly safeCode: McpResponseFailureCode;
  readonly safeMessage: string;
  constructor(code: McpResponseFailureCode) {
    super(code);
    this.safeCode = code;
    this.safeMessage = MESSAGES[code];
  }
}
