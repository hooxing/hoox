import { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PtcProgramInput, runPtcProgram } from "./ptc-runtime.js";
import { projectToolFailure, PtcToolCallError } from "./tool-failure.js";

const noTools = async (): Promise<unknown> => {
  throw new Error("不应调用工具");
};
const run = (code: string, options: Partial<Omit<PtcProgramInput, "code">> = {}) =>
  runPtcProgram({ code, toolNames: [], callTool: noTools, ...options });

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.restoreAllMocks());

describe("PTC 真实 QuickJS WASM 执行", () => {
  it("支持循环、条件、顶层 await，输出只包含精选日志及 return", async () => {
    const callTool = vi.fn(async (_name: string, args: Readonly<Record<string, unknown>>) => ({
      id: args.id,
      keep: Number(args.id) % 2 === 0,
      internal: "不应自动输出".repeat(100),
    }));
    const result = await run(
      `
      const selected = [];
      for (let id = 0; id < 5; id++) {
        const row = await tools.lookup({id});
        if (row.keep) selected.push(row.id);
      }
      console.log("精选", selected);
      return {selected};
    `,
      { toolNames: ["lookup"], callTool },
    );
    expect(result).toEqual({ logs: ["精选 [0,2,4]"], value: { selected: [0, 2, 4] } });
    expect(callTool).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(result)).not.toContain("不应自动输出");
  });

  it("中间表达式和工具结果不自动返回，无 return 正常完成", async () => {
    expect(await run("1 + 2;")).toEqual({ logs: [] });
    expect(
      await run("await tools.read({});", {
        toolNames: ["read"],
        callTool: async () => ({ secret: "中间值" }),
      }),
    ).toEqual({ logs: [] });
    expect(await run("return undefined;")).toEqual({ logs: [] });
    expect(await run("return null;")).toEqual({ logs: [], value: null });
  });

  it("每次 run 的全局与原型状态独立", async () => {
    await run("globalThis.marker = 7; Object.prototype.marker = 8;");
    expect(await run("return [typeof marker, typeof ({}).marker];")).toEqual({
      logs: [],
      value: ["undefined", "undefined"],
    });
    const [a, b] = await Promise.all([
      run("globalThis.marker = 1; return marker;"),
      run("return typeof marker;"),
    ]);
    expect(a.value).toBe(1);
    expect(b.value).toBe("undefined");
  });

  it("不暴露 Node、网络、文件、计时器或宿主回调", async () => {
    const result = await run(`return [
      typeof process, typeof require, typeof module, typeof Buffer, typeof fs,
      typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof setTimeout,
      typeof callTool, typeof submitTool, typeof rejectPtc, typeof emitLog, typeof Proxy,
      Function("return typeof process")()
    ];`);
    expect(result.value).toEqual(Array(15).fill("undefined"));
  });

  it.each([
    "return tools.constructor;",
    "return tools.__proto__;",
    "return tools.prototype;",
    "Object.getPrototypeOf(tools);",
    "Reflect.getPrototypeOf(tools);",
    "tools.read.constructor;",
    "Object.getPrototypeOf(tools.read);",
    "tools.unknown({});",
    "tools.read = () => {};",
    "delete tools.read;",
    "Object.setPrototypeOf(tools, {});",
    "console.log.constructor;",
    "console.error('x');",
  ])("拒绝能力 namespace 与 prototype 访问：%s", async (code) => {
    const callTool = vi.fn(async () => null);
    await expect(run(code, { toolNames: ["read"], callTool })).rejects.toThrow(/命名空间|原型/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    "ptc",
    "run_code",
    "run_ptc",
    "ptc_run",
    "execute_ptc",
    "runPtcProgram",
    "programmatic_tool_call",
    "__proto__",
    "constructor",
    "prototype",
    "fs.read",
  ])("拒绝递归或危险工具名称 %s", async (name) => {
    await expect(run("", { toolNames: [name] })).rejects.toThrow(/工具名称/);
  });

  it("普通工具错误可 try/catch，并且不泄漏宿主异常", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "fail") throw new Error("宿主秘密值");
      return { ok: true };
    });
    const result = await run(
      `
      let failure;
      try { await tools.fail({}); } catch (error) { failure = error.message; }
      return {failure, next: await tools.ok({})};
    `,
      { toolNames: ["fail", "ok"], callTool },
    );
    expect(result.value).toEqual({ failure: "PTC 工具调用失败", next: { ok: true } });
    expect(JSON.stringify(result)).not.toContain("宿主秘密值");
    await expect(run("await tools.fail({});", { toolNames: ["fail"], callTool })).rejects.toThrow(
      /未捕获/,
    );
  });

  it.each(["EXEC_TIMEOUT", "READ_NOT_FOUND", "PTC_TOOL_INVALID_ARGUMENTS", "HOST_UNKNOWN"])(
    "真实 WASM 可捕获受控工具失败 %s，读取 code/toolName 后继续调用",
    async (code) => {
      const hostError = new Error(
        JSON.stringify({
          code,
          message: "宿主诊断占位",
          stdout: "宿主诊断占位",
          stderr: "宿主诊断占位",
          stack: "宿主诊断占位",
          details: { token: "宿主诊断占位" },
        }),
      );
      const failure = projectToolFailure(hostError);
      const wrapped = new PtcToolCallError("fail", failure);
      Object.assign(wrapped, {
        cause: hostError,
        stdout: "宿主诊断占位",
        stderr: "宿主诊断占位",
        details: { token: "宿主诊断占位" },
        stack: "宿主诊断占位",
      });
      const callTool = vi.fn(async (name: string) => {
        if (name === "fail") throw wrapped;
        return { ok: true };
      });
      const result = await run(
        `
        let failure;
        try { await tools.fail({}); } catch (error) {
          failure = {
            code: error.code, message: error.message, toolName: error.toolName,
            isError: error instanceof Error,
            ownKeys: Object.getOwnPropertyNames(error).sort(),
            extras: [error.cause, error.stdout, error.stderr, error.details, error.failure,
              error.toJSON].map(value => typeof value),
            stack: typeof error.stack === "string" ? error.stack : ""
          };
        }
        return {failure, next: await tools.ok({})};
        `,
        { toolNames: ["fail", "ok"], callTool },
      );
      expect(result.value).toMatchObject({
        failure: {
          ...failure,
          toolName: "fail",
          isError: true,
          extras: Array(6).fill("undefined"),
        },
        next: { ok: true },
      });
      const guest = result.value as { failure: { ownKeys: string[] } };
      expect(guest.failure.ownKeys.filter((key) => key !== "stack").sort()).toEqual([
        "code",
        "message",
        "toolName",
      ]);
      expect(JSON.stringify(result)).not.toContain("宿主诊断占位");
      expect(callTool.mock.calls.map(([name]) => name)).toEqual(["fail", "ok"]);
      await expect(run("await tools.fail({});", { toolNames: ["fail"], callTool })).rejects.toThrow(
        "PTC JavaScript 执行失败（未捕获异常或工具错误）",
      );
    },
  );

  it("普通宿主异常不读取 getter/toJSON，未知 guest 失败保留原文案并附工具名", async () => {
    const hook = vi.fn(() => {
      throw new Error("不应执行宿主钩子");
    });
    const accessorError = new Error();
    for (const key of ["message", "code", "toolName", "failure", "stack", "details", "toJSON"])
      Object.defineProperty(accessorError, key, { get: hook });
    const proxy = new Proxy(new Error(), { get: hook, getPrototypeOf: hook });
    const errors: unknown[] = [
      accessorError,
      {
        get message() {
          return hook();
        },
        toJSON: hook,
      },
      new Error('{"code":"EXEC_TIMEOUT","message":"宿主诊断占位"}'),
      { failure: { code: "EXEC_TIMEOUT", message: "宿主诊断占位" }, toolName: "宿主诊断占位" },
      proxy,
    ];
    const callTool = vi.fn(async (name: string) => {
      if (name === "fail") throw errors.shift();
      return { ok: true };
    });
    const result = await run(
      `
      const failures = [];
      for (let i = 0; i < 5; i++) {
        try { await tools.fail({}); } catch (error) {
          failures.push({code: error.code, message: error.message, toolName: error.toolName});
        }
      }
      return {failures, next: await tools.ok({})};
      `,
      { toolNames: ["fail", "ok"], callTool },
    );
    expect(result.value).toEqual({
      failures: Array(5).fill({
        code: "TOOL_FAILED",
        message: "PTC 工具调用失败",
        toolName: "fail",
      }),
      next: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain("宿主诊断占位");
    expect(hook).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(6);
  });

  it.each(["EXEC_TIMEOUT", "TOOL_FAILED", "HOST_UNKNOWN"])(
    "真实 WASM 不透传构造器输入的任意 message：%s",
    async (code) => {
      const failure = projectToolFailure(new Error(JSON.stringify({ code })));
      const error = new PtcToolCallError("fail", { code, message: "宿主诊断占位" });
      const callTool = vi.fn(async (name: string) => {
        if (name === "fail") throw error;
        return { ok: true };
      });
      const result = await run(
        `
        let failure;
        try { await tools.fail({}); } catch (error) {
          failure = {code: error.code, message: error.message, toolName: error.toolName};
        }
        return {failure, next: await tools.ok({})};
        `,
        { toolNames: ["fail", "ok"], callTool },
      );
      expect(result.value).toEqual({
        failure: { ...failure, toolName: "fail" },
        next: { ok: true },
      });
      expect(JSON.stringify(result)).not.toContain("宿主诊断占位");
      expect(callTool.mock.calls.map(([name]) => name)).toEqual(["fail", "ok"]);
    },
  );

  it("真实 WASM 只用私有登记，忽略公开字段篡改与子类/实例 getter", async () => {
    const hook = vi.fn(() => {
      throw new Error("不应读取宿主异常属性");
    });
    const original = {
      code: "EXEC_TIMEOUT",
      get message() {
        return hook();
      },
    };
    const modified = new PtcToolCallError("fail", original);
    Object.assign(modified, {
      message: "宿主诊断占位",
      failure: { code: "HOST_UNKNOWN", message: "宿主诊断占位" },
      toolName: "宿主诊断占位",
      stdout: "宿主诊断占位",
      stderr: "宿主诊断占位",
      details: "宿主诊断占位",
    });
    const accessor = new PtcToolCallError("fail", original);
    for (const key of ["message", "failure", "toolName", "stack", "details", "toJSON"])
      Object.defineProperty(accessor, key, { get: hook });
    class HostileSubclass extends PtcToolCallError {}
    const subclass = new HostileSubclass("fail", original);
    for (const key of ["message", "failure", "toolName", "stack", "toJSON"]) {
      Reflect.deleteProperty(subclass, key);
      Object.defineProperty(HostileSubclass.prototype, key, { get: hook });
    }
    const errors = [modified, accessor, subclass];
    const callTool = vi.fn(async (name: string) => {
      if (name === "fail") throw errors.shift();
      return { ok: true };
    });
    const result = await run(
      `
      const failures = [];
      for (let i = 0; i < 3; i++) {
        try { await tools.fail({}); } catch (error) {
          failures.push({
            code: error.code, message: error.message, toolName: error.toolName,
            stack: typeof error.stack === "string" ? error.stack : "",
            extras: [error.stdout, error.stderr, error.details, error.failure, error.toJSON]
              .map(value => typeof value)
          });
        }
      }
      return {failures, next: await tools.ok({})};
      `,
      { toolNames: ["fail", "ok"], callTool },
    );
    const guest = result.value as { failures: unknown[]; next: unknown };
    expect(guest.failures).toHaveLength(3);
    for (const failure of guest.failures)
      expect(failure).toMatchObject({
        code: "EXEC_TIMEOUT",
        message: "命令执行超时，请检查任务状态",
        toolName: "fail",
        extras: Array(5).fill("undefined"),
      });
    expect(guest.next).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("宿主诊断占位");
    expect(hook).not.toHaveBeenCalled();
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["fail", "fail", "fail", "ok"]);
  });

  it("真实 WASM 将伪造 prototype、克隆和代理当作普通未知错误，不读取任何字段", async () => {
    const hook = vi.fn(() => {
      throw new Error("不应执行宿主访问器或 trap");
    });
    const forged = Object.create(PtcToolCallError.prototype, {
      message: { get: hook },
      failure: { get: hook },
      toolName: { get: hook },
    });
    const forgedData = Object.assign(Object.create(PtcToolCallError.prototype), {
      message: "宿主诊断占位",
      failure: { code: "EXEC_TIMEOUT", message: "宿主诊断占位" },
      toolName: "宿主诊断占位",
    });
    const actual = new PtcToolCallError("fail", { code: "EXEC_TIMEOUT", message: "宿主诊断占位" });
    const fakeError = new Error("宿主诊断占位");
    Object.setPrototypeOf(fakeError, PtcToolCallError.prototype);
    class HostileSubclass extends PtcToolCallError {}
    const fakeSubclass = Object.create(HostileSubclass.prototype, {
      message: { get: hook },
      failure: { get: hook },
      toolName: { get: hook },
    });
    const prototypeProxy = new Error();
    Object.setPrototypeOf(prototypeProxy, new Proxy({}, { get: hook, getPrototypeOf: hook }));
    const revoked = Proxy.revocable(actual, {});
    revoked.revoke();
    const errors: unknown[] = [
      forged,
      forgedData,
      fakeError,
      fakeSubclass,
      Object.create(actual),
      prototypeProxy,
      new Proxy(actual, { get: hook, getPrototypeOf: hook }),
      revoked.proxy,
    ];
    const callTool = vi.fn(async (name: string) => {
      if (name === "fail") throw errors.shift();
      return { ok: true };
    });
    const result = await run(
      `
      const failures = [];
      for (let i = 0; i < 8; i++) {
        try { await tools.fail({}); } catch (error) {
          failures.push({code: error.code, message: error.message, toolName: error.toolName});
        }
      }
      return {failures, next: await tools.ok({})};
      `,
      { toolNames: ["fail", "ok"], callTool },
    );
    expect(result.value).toEqual({
      failures: Array(8).fill({
        code: "TOOL_FAILED",
        message: "PTC 工具调用失败",
        toolName: "fail",
      }),
      next: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain("宿主诊断占位");
    expect(hook).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(9);
  });

  it("用户异常和语法错误均拒绝，不执行宿主转换方法", async () => {
    await expect(run("return }")).rejects.toThrow(/语法|执行/);
    await expect(
      run(`throw {get message() {while(true) {}}, toString() {while(true) {}}};`, {
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/执行失败/);
  });

  it.each([
    "undefined",
    "NaN",
    "Infinity",
    "-Infinity",
    "-0",
    "1n",
    "() => 1",
    "Symbol('x')",
    "new Date()",
    "new Map()",
    "new Set()",
    "new Uint8Array([1])",
    "new Number(1)",
    "[1,,3]",
    "{x: undefined}",
    "Object.create({x: 1})",
    "{constructor: 1}",
    "JSON.parse('{\"__proto__\": 1}')",
    "{prototype: 1}",
    "Object.defineProperty({}, 'x', {value: 1, enumerable: false})",
    "Object.defineProperty({}, 'x', {get() {throw new Error('不可执行')}, enumerable: true})",
    "({[Symbol('x')]: 1})",
    "Object.assign([1], {extra: 2})",
    "(() => {const x = {}; x.self = x; return x;})()",
    "{toJSON() {return 1}}",
  ])("工具参数拒绝非无损 JSON：%s", async (expression) => {
    const callTool = vi.fn(async () => null);
    await expect(
      run(`await tools.use({item: (${expression})});`, { toolNames: ["use"], callTool }),
    ).rejects.toThrow(/JSON/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("getter 不执行，JSON 与限额错误不能被 guest catch 后绕过", async () => {
    const callTool = vi.fn(async () => null);
    await expect(
      run(
        `
      try { await tools.use({get value() { console.log("getter执行了"); return 1; }}); } catch {}
      await tools.use({});
    `,
        { toolNames: ["use"], callTool },
      ),
    ).rejects.toThrow(/JSON/);
    expect(callTool).not.toHaveBeenCalled();
    await expect(run(`try {console.log(undefined);} catch {} return 1;`)).rejects.toThrow(/JSON/);
    await expect(run("return {value: undefined};")).rejects.toThrow(/JSON/);
  });

  it("原型重写和反射构造不能将 guest 特殊对象伪装成 JSON", async () => {
    for (const code of [
      "return Object.setPrototypeOf(new Map(), null);",
      "return Reflect.setPrototypeOf(new Date(), null);",
      "const value = new Map(); value.__proto__ = null; return value;",
      "function F() {} F.prototype = Object.prototype; return Reflect.construct(Map, [], F);",
    ])
      await expect(run(code)).rejects.toThrow(/原型/);
  });

  it("宿主特殊对象即使原型被剥除也不允许进入 JSON", async () => {
    for (const value of [
      new Map(),
      new Set(),
      new Date(),
      new Uint8Array([1]),
      Promise.resolve(1),
      new Number(1),
      /x/,
      new Error("秘密"),
    ]) {
      Object.setPrototypeOf(value, null);
      await expect(
        run("return await tools.read({});", { toolNames: ["read"], callTool: async () => value }),
      ).rejects.toThrow(/结果.*JSON/);
    }
  });

  it("Object.prototype 污染不能将访问器伪装成数据属性", async () => {
    const callTool = vi.fn(async () => null);
    await expect(
      run(
        `
      Object.prototype.value = 7;
      await tools.read({get x() {throw new Error("不得执行");}});
    `,
        { toolNames: ["read"], callTool },
      ),
    ).rejects.toThrow(/JSON/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("宿主工具结果拒绝 getter、Proxy、特殊对象和 undefined", async () => {
    const getter = vi.fn(() => "不应执行");
    const trap = vi.fn(() => []);
    const invalid = [
      undefined,
      NaN,
      -0,
      new Date(),
      new Map(),
      [undefined],
      Object.create({ x: 1 }),
      Object.defineProperty({}, "x", { get: getter, enumerable: true }),
      new Proxy({}, { ownKeys: trap }),
      JSON.parse('{"__proto__": 1}'),
    ];
    for (const value of invalid) {
      await expect(
        run("return await tools.read({});", { toolNames: ["read"], callTool: async () => value }),
      ).rejects.toThrow(/结果.*JSON/);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it("桥接保持合法 JSON 并捕获原生方法，不能用改写 JSON.stringify 绕过校验", async () => {
    const value = { text: "中文\ud800", zero: 0, nested: [true, false, null, { n: 0.125 }] };
    const result = await run(
      `
      JSON.stringify = () => '"伪造"';
      JSON.parse = () => ({forged: true});
      Reflect.ownKeys = () => [];
      return await tools.echo({text: "中文\\ud800", zero: 0, nested: [true, false, null, {n: 0.125}]});
    `,
      { toolNames: ["echo"], callTool: async (_name, args) => args },
    );
    expect(result.value).toEqual(value);
  });

  it("Promise.all 并发提交按提交顺序串行调用", async () => {
    const first = deferred<unknown>();
    const started = deferred<void>();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const callTool = async (_name: string, args: Readonly<Record<string, unknown>>) => {
      active++;
      peak = Math.max(peak, active);
      const id = Number(args.id);
      order.push(id);
      if (id === 0) {
        started.resolve();
        await first.promise;
      }
      await tick();
      active--;
      return { id };
    };
    const execution = run("return await Promise.all([0,1,2].map(id => tools.work({id})));", {
      toolNames: ["work"],
      callTool,
    });
    await started.promise;
    expect(order).toEqual([0]);
    first.resolve(null);
    expect((await execution).value).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    expect(order).toEqual([0, 1, 2]);
    expect(peak).toBe(1);
  });

  it("未 await 的已提交调用仍等待完成，调用参数按提交时快照隔离", async () => {
    const first = deferred<unknown>();
    const started = deferred<void>();
    const callTool = vi.fn(async (_name: string, args: Readonly<Record<string, unknown>>) => {
      started.resolve();
      await first.promise;
      return args;
    });
    let settled = false;
    const execution = run("const args = {id: 1}; tools.work(args); args.id = 2; return '完成';", {
      toolNames: ["work"],
      callTool,
    }).finally(() => {
      settled = true;
    });
    await started.promise;
    await tick();
    expect(settled).toBe(false);
    expect(callTool.mock.calls[0]?.[1]).toEqual({ id: 1 });
    first.resolve(null);
    expect((await execution).value).toBe("完成");
  });

  it("同步死循环与微任务死循环在期限内中断", async () => {
    for (const code of [
      "while (true) {}",
      "while (true) {await Promise.resolve();}",
      "await new Promise(() => {});",
    ]) {
      const start = Date.now();
      await expect(run(code, { timeoutMs: 150 })).rejects.toThrow(/超时/);
      expect(Date.now() - start).toBeLessThan(2500);
    }
  });

  it("已经取消的请求不发起工具调用", async () => {
    const controller = new AbortController();
    controller.abort(new Error("不应输出取消原因"));
    const callTool = vi.fn(async () => null);
    await expect(
      run("await tools.work({});", { toolNames: ["work"], callTool, signal: controller.signal }),
    ).rejects.toThrow("PTC 执行已取消");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("等待 guest Promise 时可外部取消", async () => {
    const controller = new AbortController();
    const execution = run("await new Promise(() => {});", {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    const assertion = expect(execution).rejects.toThrow(/取消/);
    await tick();
    controller.abort();
    await assertion;
  });

  it.each(["取消", "超时"])("%s 后不启动排队调用，并等待在途调用收束", async (mode) => {
    const controller = new AbortController();
    const first = deferred<unknown>();
    const started = deferred<void>();
    const callTool = vi.fn(async () => {
      started.resolve();
      return await first.promise;
    });
    let settled = false;
    const execution = run("return await Promise.all([tools.work({id: 1}), tools.work({id: 2})]);", {
      toolNames: ["work"],
      callTool,
      signal: controller.signal,
      timeoutMs: mode === "超时" ? 250 : 2000,
    }).finally(() => {
      settled = true;
    });
    const assertion = expect(execution).rejects.toThrow(mode);
    await started.promise;
    if (mode === "取消") controller.abort();
    else await new Promise((resolve) => setTimeout(resolve, 300));
    await tick();
    expect(settled).toBe(false);
    expect(callTool).toHaveBeenCalledTimes(1);
    first.resolve({ done: true });
    await assertion;
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("取消后在途调用拒绝也不会产生孤儿异常", async () => {
    const controller = new AbortController();
    const first = deferred<unknown>();
    const started = deferred<void>();
    const execution = run("await tools.work({});", {
      toolNames: ["work"],
      signal: controller.signal,
      callTool: async () => {
        started.resolve();
        return await first.promise;
      },
    });
    const assertion = expect(execution).rejects.toThrow(/取消/);
    await started.promise;
    controller.abort();
    first.reject(new Error("宿主秘密"));
    await assertion;
  });

  it("调用上限计算提交数，超限后即使 catch 也不得新发起", async () => {
    const callTool = vi.fn(async () => null);
    await expect(
      run("for (let i=0;i<65;i++) await tools.work({});", { toolNames: ["work"], callTool }),
    ).rejects.toThrow(/次数限额/);
    expect(callTool).toHaveBeenCalledTimes(64);
    callTool.mockClear();
    await expect(
      run("try {tools.work({}); tools.work({});} catch {}", {
        toolNames: ["work"],
        callTool,
        maxCalls: 1,
      }),
    ).rejects.toThrow(/次数限额/);
    expect(callTool).not.toHaveBeenCalled();
    await expect(
      run("await tools.work({});", { toolNames: ["work"], callTool, maxCalls: 0 }),
    ).rejects.toThrow(/次数限额/);
  });

  it("输出按 UTF-8 字节及日志分隔计费，中间结果不消耗输出预算", async () => {
    expect((await run("console.log('中'); return 1;", { maxOutputBytes: 5 })).logs).toEqual(["中"]);
    await expect(run("console.log('中'); return 1;", { maxOutputBytes: 4 })).rejects.toThrow(
      /字节限额/,
    );
    await expect(run("return 'x'.repeat(65536);")).rejects.toThrow(/字节限额/);
    await expect(
      run("while(true) console.log();", { maxOutputBytes: 5, timeoutMs: 1000 }),
    ).rejects.toThrow(/字节限额/);
    expect(
      await run("const value = await tools.read({}); return value.length;", {
        toolNames: ["read"],
        callTool: async () => "x".repeat(100000),
        maxOutputBytes: 6,
      }),
    ).toEqual({ logs: [], value: 100000 });
  });

  it("内存膨胀由 32MiB heap 限制拒绝，后续运行仍可用", async () => {
    await expect(
      run(
        "const values = []; for(let i=0;i<1000000;i++) values.push({i, text: 'x'.repeat(100)}); return values;",
        { timeoutMs: 3000 },
      ),
    ).rejects.toThrow(/执行|JSON/);
    expect((await run("return 7;")).value).toBe(7);
  });

  it("取消在途调用时不会提前释放其 VM，排队句柄也最终释放", async () => {
    const runtimeDispose = vi.spyOn(QuickJSRuntime.prototype, "dispose");
    const contextDispose = vi.spyOn(QuickJSContext.prototype, "dispose");
    const controller = new AbortController();
    const first = deferred<unknown>();
    const started = deferred<void>();
    const execution = run("await Promise.all([tools.work({id:1}), tools.work({id:2})]);", {
      toolNames: ["work"],
      signal: controller.signal,
      callTool: async () => {
        started.resolve();
        return await first.promise;
      },
    });
    const assertion = expect(execution).rejects.toThrow(/取消/);
    await started.promise;
    controller.abort();
    await tick();
    expect(runtimeDispose).not.toHaveBeenCalled();
    expect(contextDispose).not.toHaveBeenCalled();
    first.resolve(null);
    await assertion;
    expect(runtimeDispose).toHaveBeenCalledTimes(1);
    expect(contextDispose).toHaveBeenCalledTimes(1);
  });

  it("重复工具名、非法配置、深层 JSON 与无限递归明确拒绝", async () => {
    await expect(run("", { toolNames: ["read", "read"] })).rejects.toThrow(/重复/);
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 0.5 },
      { timeoutMs: Infinity },
      { maxCalls: -1 },
      { maxOutputBytes: NaN },
    ]) {
      await expect(run("", options)).rejects.toThrow(/整数/);
    }
    expect(await run("", { maxCalls: 0, maxOutputBytes: 0 })).toEqual({ logs: [] });
    await expect(
      run("let value = {}; for (let i=0;i<300;i++) value={value}; return value;"),
    ).rejects.toThrow(/JSON/);
    await expect(run("function recursive() {return recursive();} recursive();")).rejects.toThrow(
      /执行/,
    );
    expect((await run("const shared = {id:1}; return [shared, shared];")).value).toEqual([
      { id: 1 },
      { id: 1 },
    ]);
  });

  it("动态 import 没有宿主模块加载入口", async () => {
    await expect(run("return await import('node:fs');")).rejects.toThrow(/执行/);
  });

  it("成功、错误、限额与中断均释放 context/runtime 及句柄", async () => {
    const runtimeDispose = vi.spyOn(QuickJSRuntime.prototype, "dispose");
    const contextDispose = vi.spyOn(QuickJSContext.prototype, "dispose");
    // 真正的 JS_FreeRuntime 还会检查活跃句柄；这里保留原实现，不 mock WASM 或释放操作。
    const cases = [
      "return 1;",
      "await tools.work({}); return 2;",
      "throw new Error('失败');",
      "return {x: undefined};",
      "while(true) {}",
    ];
    for (const code of cases) {
      await run(code, {
        toolNames: ["work"],
        callTool: async () => ({ ok: true }),
        timeoutMs: 150,
      }).catch(() => {});
    }
    expect(contextDispose).toHaveBeenCalledTimes(cases.length);
    expect(runtimeDispose).toHaveBeenCalledTimes(cases.length);
    expect(
      runtimeDispose.mock.contexts.every(
        (runtime) => runtime instanceof QuickJSRuntime && !runtime.alive,
      ),
    ).toBe(true);
    expect(
      contextDispose.mock.contexts.every(
        (context) => context instanceof QuickJSContext && !context.alive,
      ),
    ).toBe(true);
  });
});
