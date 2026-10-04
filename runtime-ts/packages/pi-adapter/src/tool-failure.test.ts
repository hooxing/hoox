import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { projectToolFailure, PtcToolCallError } from "./tool-failure.js";

const unknownFailure = {
  code: "TOOL_FAILED",
  message: "工具调用失败，请根据任务状态检查后再决定是否重试",
};
const encodedError = (code: string) =>
  new Error(
    JSON.stringify({
      code,
      message: "宿主诊断占位",
      stdout: "宿主诊断占位",
      stderr: "宿主诊断占位",
      stack: "宿主诊断占位",
      details: { code: "EXEC_TIMEOUT", token: "宿主诊断占位" },
    }),
  );

const knownCodes = [
  "EXEC_INVALID_ARGUMENTS",
  "EXEC_INVALID_ARGUMENT",
  "EXEC_TIMEOUT",
  "EXEC_CANCELLED",
  "EXEC_REJECTED",
  "EXEC_UNAVAILABLE",
  "READ_INVALID_ARGUMENTS",
  "READ_INVALID_ARGUMENT",
  "READ_TIMEOUT",
  "READ_CANCELLED",
  "READ_REJECTED",
  "READ_UNAVAILABLE",
  "READ_NOT_FOUND",
  "READ_OFFSET_OUT_OF_RANGE",
  "READ_IMAGE_TOO_LARGE",
  "READ_INVALID_IMAGE",
  "EDIT_INVALID_ARGUMENTS",
  "EDIT_INVALID_ARGUMENT",
  "EDIT_TIMEOUT",
  "EDIT_CANCELLED",
  "EDIT_REJECTED",
  "EDIT_UNAVAILABLE",
  "EDIT_NOT_FOUND",
  "EDIT_EMPTY_OLD_TEXT",
  "EDIT_NO_CHANGE",
  "EDIT_NO_MATCH",
  "EDIT_NOT_UNIQUE",
  "EDIT_OVERLAP",
  "WRITE_INVALID_ARGUMENTS",
  "WRITE_INVALID_ARGUMENT",
  "WRITE_TIMEOUT",
  "WRITE_CANCELLED",
  "WRITE_REJECTED",
  "WRITE_UNAVAILABLE",
  "WRITE_NOT_FOUND",
  "WRITE_PARENT_FAILED",
  "FILE_BUSY",
  "TODO_ARGUMENTS_INVALID",
  "AUTOMATION_ARGUMENTS_INVALID",
  "SKILL_ARGUMENTS_INVALID",
  "SKILL_NOT_INSTALLED",
  "SKILL_REVOKED",
  "SKILL_INCOMPATIBLE",
  "SKILL_CONTENT_UNAVAILABLE",
  "SKILL_CONTEXT_LIMIT",
  "SKILL_PROTOCOL",
  "PTC_TOOL_INVALID_ARGUMENTS",
];

describe("工具失败安全投影", () => {
  it.each(knownCodes)("只保留白名单 %s 与固定中文提示", (code) => {
    const failure = projectToolFailure(encodedError(code));
    expect(failure.code).toBe(code);
    expect(failure.message).toMatch(/[\u4e00-\u9fff]/u);
    expect(Object.keys(failure).sort()).toEqual(["code", "message"]);
    expect(failure).toEqual(projectToolFailure(new Error(JSON.stringify({ code }))));
    expect(JSON.stringify(failure)).not.toContain("宿主诊断占位");
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it("参数无效的 PTC 错误使用固定提示", () => {
    expect(projectToolFailure(encodedError("PTC_TOOL_INVALID_ARGUMENTS"))).toEqual({
      code: "PTC_TOOL_INVALID_ARGUMENTS",
      message: "PTC 工具参数无效，请检查参数",
    });
  });

  it.each([
    undefined,
    null,
    42,
    '{"code":"EXEC_TIMEOUT"}',
    { message: '{"code":"EXEC_TIMEOUT"}' },
    new Error("宿主诊断占位"),
    new Error("EXEC_TIMEOUT"),
    new Error('{"code":"EXEC_TIMEOUT",'),
    new Error("null"),
    new Error("42"),
    new Error('"{\\"code\\":\\"EXEC_TIMEOUT\\"}"'),
    new Error('[{"code":"EXEC_TIMEOUT"}]'),
    new Error('{"code":42}'),
    new Error('{"details":{"code":"EXEC_TIMEOUT"}}'),
    new Error('{"__proto__":{"code":"EXEC_TIMEOUT"}}'),
    encodedError("EXEC_HOST_SECRET"),
    encodedError("READ_HOST_SECRET"),
    encodedError("EDIT_HOST_SECRET"),
    encodedError("WRITE_HOST_SECRET"),
    encodedError("constructor"),
    encodedError("toString"),
    new Error(`{"code":"EXEC_TIMEOUT","details":"${"x".repeat(16 * 1_024)}"}`),
  ])("未知、非 Error 或过长编码退回通用失败（样本 %#）", (error) => {
    expect(projectToolFailure(error)).toEqual(unknownFailure);
  });

  it("有界编码最多解码一次，长度上限内仍可识别白名单", () => {
    const prefix = '{"code":"EXEC_TIMEOUT","details":"';
    const encoded = `${prefix}${"x".repeat(16 * 1_024 - prefix.length - 2)}"}`;
    expect(encoded.length).toBe(16 * 1_024);
    expect(projectToolFailure(new Error(encoded)).code).toBe("EXEC_TIMEOUT");
    expect(projectToolFailure(new Error(JSON.stringify(encoded)))).toEqual(unknownFailure);
  });

  it("不读取 message 访问器、继承字段、其他宿主字段或转换钩子", () => {
    const hook = vi.fn(() => {
      throw new Error("不应执行宿主钩子");
    });
    const accessorError = new Error();
    Object.defineProperty(accessorError, "message", { get: hook });
    expect(projectToolFailure(accessorError)).toEqual(unknownFailure);

    const inheritedError = new Error();
    Object.setPrototypeOf(
      inheritedError,
      Object.create(Error.prototype, { message: { get: hook } }),
    );
    expect(projectToolFailure(inheritedError)).toEqual(unknownFailure);

    const error = encodedError("EXEC_TIMEOUT");
    for (const key of ["code", "details", "stack", "stdout", "stderr", "toJSON", "toString"])
      Object.defineProperty(error, key, { get: hook });
    expect(projectToolFailure(error).code).toBe("EXEC_TIMEOUT");
    const object = {
      get message() {
        return hook();
      },
      toJSON: hook,
      toString: hook,
    };
    expect(projectToolFailure(object)).toEqual(unknownFailure);
    const methodError = encodedError("READ_NOT_FOUND");
    Object.assign(methodError, { toJSON: hook, toString: hook });
    expect(projectToolFailure(methodError).code).toBe("READ_NOT_FOUND");
    expect(hook).not.toHaveBeenCalled();
  });

  it("不触发 Proxy trap，包括已撤销 Proxy", () => {
    const trap = vi.fn(() => {
      throw new Error("不应执行 Proxy trap");
    });
    const proxy = new Proxy(encodedError("EXEC_TIMEOUT"), {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
    });
    expect(projectToolFailure(proxy)).toEqual(unknownFailure);
    const revoked = Proxy.revocable(encodedError("EXEC_TIMEOUT"), {});
    revoked.revoke();
    expect(projectToolFailure(revoked.proxy)).toEqual(unknownFailure);
    expect(trap).not.toHaveBeenCalled();
  });

  it("接受其他 realm 中真实 Error 的自有 message 数据字段", () => {
    const error: unknown = runInNewContext('new Error(\'{"code":"EXEC_TIMEOUT"}\')');
    expect(projectToolFailure(error).code).toBe("EXEC_TIMEOUT");
  });

  it("包装仅保存工具名和受控失败，不保留源对象的诊断字段", () => {
    const failure = {
      ...projectToolFailure(encodedError("EXEC_TIMEOUT")),
      details: "宿主诊断占位",
    };
    const error = new PtcToolCallError("exec_command", failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PtcToolCallError");
    expect(error.message).toBe("命令执行超时，请检查任务状态");
    expect(error.toolName).toBe("exec_command");
    expect(error.failure).toEqual({ code: "EXEC_TIMEOUT", message: error.message });
    expect(Object.isFrozen(error.failure)).toBe(true);
    failure.message = "宿主诊断占位";
    expect(error.failure.message).toBe("命令执行超时，请检查任务状态");
    expect(JSON.stringify(error)).not.toContain("宿主诊断占位");
  });
});
