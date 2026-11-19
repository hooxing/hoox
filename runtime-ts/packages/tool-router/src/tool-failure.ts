import { types } from "node:util";

import type { ToolFailure } from "@hoox/run-contracts/runtime-agent-event";

export type { ToolFailure } from "@hoox/run-contracts/runtime-agent-event";

const MAX_ENCODED_ERROR_LENGTH = 16 * 1_024;
const UNKNOWN_FAILURE: ToolFailure = Object.freeze({
  code: "TOOL_FAILED",
  message: "工具调用失败，请根据任务状态检查后再决定是否重试",
});

// 仅列出工具实现实际产生的错误码，禁止按前缀放行或透传宿主诊断。
const FAILURE_MESSAGES = new Map<string, string>([
  ["EXEC_INVALID_ARGUMENTS", "命令参数无效，请检查参数"],
  ["EXEC_INVALID_ARGUMENT", "命令参数无效，请检查参数"],
  ["EXEC_TIMEOUT", "命令执行超时，请检查任务状态"],
  ["EXEC_CANCELLED", "命令执行已取消，请检查任务状态"],
  ["EXEC_REJECTED", "命令执行被拒绝，请检查任务状态"],
  ["EXEC_UNAVAILABLE", "命令服务暂时不可用，请检查任务状态"],
  ["READ_INVALID_ARGUMENTS", "读取参数无效，请检查参数"],
  ["READ_INVALID_ARGUMENT", "读取参数无效，请检查参数"],
  ["READ_TIMEOUT", "文件读取超时，请检查任务状态"],
  ["READ_CANCELLED", "文件读取已取消，请检查任务状态"],
  ["READ_REJECTED", "文件读取被拒绝，请检查任务状态"],
  ["READ_UNAVAILABLE", "文件读取服务暂时不可用，请检查任务状态"],
  ["READ_NOT_FOUND", "指定文件或目录不存在，请检查路径"],
  ["READ_OFFSET_OUT_OF_RANGE", "读取起始行超出文件范围，请检查参数"],
  ["READ_IMAGE_TOO_LARGE", "图片超过模型内联输入上限，请调整输入"],
  ["READ_INVALID_IMAGE", "图片格式无效或不受支持，请检查输入"],
  ["EDIT_INVALID_ARGUMENTS", "编辑参数无效，请检查参数"],
  ["EDIT_INVALID_ARGUMENT", "编辑参数无效，请检查参数"],
  ["EDIT_TIMEOUT", "文件编辑超时，请检查任务状态"],
  ["EDIT_CANCELLED", "文件编辑已取消，请检查任务状态"],
  ["EDIT_REJECTED", "文件编辑被拒绝，请检查任务状态"],
  ["EDIT_UNAVAILABLE", "文件编辑服务暂时不可用，请检查任务状态"],
  ["EDIT_NOT_FOUND", "指定文件或目录不存在，请检查路径"],
  ["EDIT_EMPTY_OLD_TEXT", "编辑匹配文本不能为空，请检查参数"],
  ["EDIT_NO_CHANGE", "编辑没有产生变化，请检查替换内容"],
  ["EDIT_NO_MATCH", "未找到编辑匹配文本，请重新检查文件内容"],
  ["EDIT_NOT_UNIQUE", "编辑匹配文本不唯一，请提供更精确的文本"],
  ["EDIT_OVERLAP", "编辑替换范围重叠，请调整替换项"],
  ["WRITE_INVALID_ARGUMENTS", "写入参数无效，请检查参数"],
  ["WRITE_INVALID_ARGUMENT", "写入参数无效，请检查参数"],
  ["WRITE_TIMEOUT", "文件写入超时，请检查任务状态"],
  ["WRITE_CANCELLED", "文件写入已取消，请检查任务状态"],
  ["WRITE_REJECTED", "文件写入被拒绝，请检查任务状态"],
  ["WRITE_UNAVAILABLE", "文件写入服务暂时不可用，请检查任务状态"],
  ["WRITE_NOT_FOUND", "指定文件或目录不存在，请检查路径"],
  ["WRITE_PARENT_FAILED", "无法准备写入目录，请检查路径和任务状态"],
  ["FILE_BUSY", "文件正在被其他调用编辑，请检查任务状态"],
  ["TODO_ARGUMENTS_INVALID", "任务清单参数无效，请检查参数"],
  ["AUTOMATION_ARGUMENTS_INVALID", "定时任务参数无效，请检查参数"],
  ["SKILL_ARGUMENTS_INVALID", "Skill 参数无效，请检查参数"],
  ["SKILL_NOT_INSTALLED", "Skill 未安装，请检查可用 Skill"],
  ["SKILL_REVOKED", "Skill 已被撤销，请检查可用 Skill"],
  ["SKILL_INCOMPATIBLE", "Skill 不兼容，请检查可用 Skill"],
  ["SKILL_CONTENT_UNAVAILABLE", "Skill 内容不可用，请检查任务状态"],
  ["SKILL_CONTEXT_LIMIT", "Skill 内容超过上下文限制，请调整输入"],
  ["SKILL_PROTOCOL", "Skill 调用状态异常，请检查任务状态"],
  ["PTC_TOOL_INVALID_ARGUMENTS", "PTC 工具参数无效，请检查参数"],
]);

type ControlledPtcToolCallError = {
  readonly toolName: string;
  readonly failure: ToolFailure;
};

// 私有登记是唯一可信来源；原型、公开属性和子类都不能伪造或更改桥接结果。
const CONTROLLED_ERRORS = new WeakMap<object, ControlledPtcToolCallError>();

function failureForCode(code: unknown): ToolFailure {
  if (typeof code !== "string" || code === "TOOL_FAILED") return UNKNOWN_FAILURE;
  const message = FAILURE_MESSAGES.get(code);
  return message === undefined ? UNKNOWN_FAILURE : Object.freeze({ code, message });
}

/** 只查询私有登记；未登记值返回 undefined，不访问属性或遍历原型。 */
export function readPtcToolCallError(error: unknown): ControlledPtcToolCallError | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function")
    return undefined;
  return CONTROLLED_ERRORS.get(error);
}

/** 只读取真实 Error 的自有 message 数据字段；固定提示不包含任何宿主诊断。 */
export function projectToolFailure(error: unknown): ToolFailure {
  if (types.isProxy(error) || !types.isNativeError(error)) return UNKNOWN_FAILURE;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return UNKNOWN_FAILURE;
  const encoded: unknown = descriptor.value;
  if (typeof encoded !== "string" || encoded.length > MAX_ENCODED_ERROR_LENGTH)
    return UNKNOWN_FAILURE;
  try {
    // 只解码一次有界字符串，不递归解释嵌套诊断，也不调用 getter/toJSON。
    const decoded: unknown = JSON.parse(encoded);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
      return UNKNOWN_FAILURE;
    const code: unknown = Object.getOwnPropertyDescriptor(decoded, "code")?.value;
    return failureForCode(code);
  } catch {
    return UNKNOWN_FAILURE;
  }
}

/** 仅从输入的自有 code 数据字段规范化并登记；不读取输入 message 或保存原始诊断。 */
export class PtcToolCallError extends Error {
  readonly toolName: string;
  readonly failure: ToolFailure;

  constructor(name: string, failure: ToolFailure) {
    const descriptor =
      typeof failure === "object" &&
      failure !== null &&
      !types.isProxy(failure) &&
      !Array.isArray(failure)
        ? Object.getOwnPropertyDescriptor(failure, "code")
        : undefined;
    const normalized = failureForCode(
      descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined,
    );
    super(normalized.message);
    Object.defineProperty(this, "name", {
      value: "PtcToolCallError",
      writable: true,
      configurable: true,
    });
    const toolName = typeof name === "string" ? name : "";
    this.toolName = toolName;
    this.failure = normalized;
    CONTROLLED_ERRORS.set(this, Object.freeze({ toolName, failure: normalized }));
  }
}
