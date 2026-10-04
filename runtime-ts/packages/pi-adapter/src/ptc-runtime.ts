import { types } from "node:util";
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import { readPtcToolCallError } from "./tool-failure.js";

export interface PtcProgramInput {
  code: string;
  toolNames: readonly string[];
  callTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxCalls?: number;
}

export interface PtcProgramResult {
  logs: readonly string[];
  value?: unknown;
}

const HEAP_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_CALLS = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const RECURSIVE_NAMES = new Set([
  "ptc",
  "run_code",
  "run_ptc",
  "ptc_run",
  "execute_ptc",
  "ptc_execute",
  "runptcprogram",
  "programmatic_tool_call",
  "programmatic_tool_calling",
]);

// 桥接不使用 JSON.stringify(object)：它会执行 getter/toJSON 并静默丢失数据。
function encodeJson(value: unknown): string {
  const ancestors = new Set<object>();
  const parts: string[] = [];
  let bytes = 0;
  const invalid: () => never = () => {
    throw new Error("PTC 数据必须为无损 JSON，禁止访问器、特殊对象及危险属性");
  };
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > HEAP_BYTES) throw new Error("PTC JSON 数据超过内存限额");
    parts.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 256) invalid();
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      append(JSON.stringify(item));
      return;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0)) invalid();
      append(JSON.stringify(item));
      return;
    }
    if (typeof item !== "object" || item === null || types.isProxy(item)) invalid();
    const object = item as object;
    if (
      types.isAnyArrayBuffer(object) ||
      types.isArrayBufferView(object) ||
      types.isBoxedPrimitive(object) ||
      types.isDate(object) ||
      types.isRegExp(object) ||
      types.isMap(object) ||
      types.isSet(object) ||
      types.isWeakMap(object) ||
      types.isWeakSet(object) ||
      types.isPromise(object) ||
      types.isNativeError(object) ||
      types.isGeneratorObject(object) ||
      types.isMapIterator(object) ||
      types.isSetIterator(object) ||
      types.isModuleNamespaceObject(object)
    )
      invalid();
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (
      array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype
    )
      invalid();
    if (ancestors.has(object)) invalid();
    ancestors.add(object);
    const keys = Reflect.ownKeys(object);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(object, "length")?.value as number;
      if (keys.length !== length + 1) invalid();
      append("[");
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
        if (i) append(",");
        visit(descriptor.value, depth + 1);
      }
      append("]");
    } else {
      append("{");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
        if (i) append(",");
        append(`${JSON.stringify(key)}:`);
        visit(descriptor.value, depth + 1);
      }
      append("}");
    }
    ancestors.delete(object);
  };
  visit(value, 0);
  return parts.join("");
}

// 这段固定引导代码只在 QuickJS 内执行。能力闭包与生成代码分别求值，不能靠词法变量名访问宿主回调。
const BOOTSTRAP = `
(function(namesJson, submit, emit, fail) {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify;
  const ownKeys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
  const getPrototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf;
  const define = Object.defineProperty, create = Object.create, freeze = Object.freeze;
  const isArray = Array.isArray, finite = Number.isFinite, same = Object.is, hasOwn = Object.hasOwn;
  const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const ProxyClass = Proxy, TypeErrorClass = TypeError;
  const dangerous = key => key === "__proto__" || key === "prototype" || key === "constructor";
  const invalid = () => { throw new TypeErrorClass("PTC 数据必须为无损 JSON"); };
  const encode = value => {
    const ancestors = create(null); ancestors.length = 0;
    const visit = (item, depth) => {
      if (depth > 256) invalid();
      if (item === null || typeof item === "string" || typeof item === "boolean") return stringify(item);
      if (typeof item === "number") {
        if (!finite(item) || same(item, -0)) invalid();
        return stringify(item);
      }
      if (typeof item !== "object" || item === null) invalid();
      const array = isArray(item), prototype = getPrototype(item);
      if (array ? prototype !== arrayPrototype : prototype !== null && prototype !== objectPrototype) invalid();
      for (let i = 0; i < ancestors.length; i++) if (ancestors[i] === item) invalid();
      ancestors[ancestors.length] = item;
      const keys = ownKeys(item);
      let text = array ? "[" : "{";
      if (array) {
        const length = descriptor(item, "length").value;
        if (keys.length !== length + 1) invalid();
        for (let i = 0; i < length; i++) {
          const entry = descriptor(item, "" + i);
          if (!entry || !hasOwn(entry, "value") || !entry.enumerable) invalid();
          if (i) text += ",";
          text += visit(entry.value, depth + 1);
        }
      } else {
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof key !== "string" || dangerous(key)) invalid();
          const entry = descriptor(item, key);
          if (!entry || !hasOwn(entry, "value") || !entry.enumerable) invalid();
          if (i) text += ",";
          text += stringify(key) + ":" + visit(entry.value, depth + 1);
        }
      }
      ancestors.length--;
      return text + (array ? "]" : "}");
    };
    return visit(value, 0);
  };
  const deny = () => fail("PTC 工具命名空间或原型访问被拒绝");
  const protect = target => new ProxyClass(freeze(setPrototype(target, null)), {
    get(target, key) {
      if (typeof key !== "string" || dangerous(key) || !descriptor(target, key)) return deny();
      return descriptor(target, key).value;
    },
    getPrototypeOf: deny, setPrototypeOf: deny, set: deny, defineProperty: deny, deleteProperty: deny
  });
  const tools = create(null);
  for (const name of parse(namesJson)) {
    const invoke = (...args) => {
      if (args.length !== 1 || args[0] === null || typeof args[0] !== "object" || isArray(args[0]))
        return fail("PTC 工具参数必须为 JSON 对象");
      let json;
      try { json = encode(args[0]); } catch { return fail("PTC 工具参数必须为无损 JSON"); }
      return submit(name, json);
    };
    define(tools, name, { value: protect(invoke), enumerable: true });
  }
  const log = (...args) => {
    let json;
    try { json = encode(args); } catch { return fail("PTC 日志必须为无损 JSON"); }
    emit(json);
  };
  const consoleObject = create(null);
  define(consoleObject, "log", { value: protect(log), enumerable: true });
  define(globalThis, "tools", { value: protect(tools) });
  define(globalThis, "console", { value: protect(consoleObject) });
  // Proxy 无可靠的无副作用反射检测；移除其构造入口，禁止用户创建会伪装为普通 JSON 的代理。
  define(globalThis, "Proxy", { value: undefined, writable: false, configurable: false });
  // 禁止反射原型重写，避免 Map/Promise 等特殊对象去掉原型后伪装为 JSON 记录。
  for (const [target, key] of [[Object, "setPrototypeOf"], [Reflect, "setPrototypeOf"], [Reflect, "construct"]])
    define(target, key, { value: deny, writable: false, configurable: false });
  define(objectPrototype, "__proto__", { get: deny, set: deny, configurable: false });
  return { encode, decode: parse };
})
`;

interface QueuedCall {
  name: string;
  args: Readonly<Record<string, unknown>>;
  deferred: QuickJSDeferredPromise;
}

function limit(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new Error(`PTC ${name}必须为${allowZero ? "非负" : "正"}安全整数`);
  }
  return result;
}

/**
 * 在独立 WASM、runtime 和 context 中执行异步函数体；仅日志及最终 return 进入输出。
 * 不开放 Proxy、反射构造及原型重写；日志按 UTF-8 字节（含每条换行）与 return JSON 共享限额。
 * 正常完成的 undefined 表示无返回值，其余边界只接受无损 JSON。工具失败脱敏后可 try/catch；
 * JSON、命名空间、限额、取消及超时错误终止整次运行。已提交的未 await 调用也会收束，
 * 取消不强杀宿主工具，因此本 Promise 必须等待在途 callTool 完成后才拒绝。
 */
export async function runPtcProgram(input: PtcProgramInput): Promise<PtcProgramResult> {
  const timeoutMs = limit(input.timeoutMs, DEFAULT_TIMEOUT_MS, "期限");
  if (timeoutMs > 2_147_483_647) throw new Error("PTC 期限超过计时器范围");
  const maxOutputBytes = limit(input.maxOutputBytes, DEFAULT_OUTPUT_BYTES, "输出限额", true);
  const maxCalls = limit(input.maxCalls, DEFAULT_MAX_CALLS, "调用限额", true);
  if (typeof input.code !== "string" || Buffer.byteLength(input.code, "utf8") > HEAP_BYTES) {
    throw new Error("PTC 代码必须为内存限额内的 JavaScript 字符串");
  }
  const names = new Set<string>();
  for (const name of input.toolNames) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      FORBIDDEN_KEYS.has(name) ||
      RECURSIVE_NAMES.has(name.toLowerCase()) ||
      names.has(name)
    ) {
      throw new Error("PTC 工具名称非法、重复或包含递归执行入口");
    }
    names.add(name);
  }

  const deadline = Date.now() + timeoutMs;
  let stopped: Error | undefined;
  let wakeStop: () => void = () => {};
  const stopEvent = new Promise<void>((resolve) => {
    wakeStop = resolve;
  });
  const stop = (message: string): Error => {
    stopped ??= new Error(message);
    wakeStop();
    return stopped;
  };
  const check = (): Error | undefined => {
    if (input.signal?.aborted) stop("PTC 执行已取消");
    if (Date.now() >= deadline) stop("PTC 执行超时");
    return stopped;
  };
  const onAbort = (): void => {
    stop("PTC 执行已取消");
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("PTC 执行超时"), timeoutMs);
  let runtime: QuickJSRuntime | undefined;
  let context: QuickJSContext | undefined;
  const handles: QuickJSHandle[] = [];
  const queue: QueuedCall[] = [];
  let activeCall: Promise<void> | undefined;
  const logs: string[] = [];
  let outputBytes = 0;
  let calls = 0;
  const addOutput = (text: string): void => {
    outputBytes += Buffer.byteLength(text, "utf8");
    if (outputBytes > maxOutputBytes) throw stop("PTC 输出超过字节限额");
  };

  try {
    if (check()) throw stopped;
    const module = await newQuickJSWASMModule();
    if (check()) throw stopped;
    runtime = module.newRuntime();
    runtime.setMemoryLimit(HEAP_BYTES);
    // 栈上限沿用同步 WASM 官方示例的 320KiB；超出原生栈容量会让递归错误破坏释放路径。
    runtime.setMaxStackSize(320 * 1024);
    runtime.setInterruptHandler(() => Boolean(check()));
    runtime.removeModuleLoader();
    const vm = runtime.newContext();
    context = vm;
    const keep = (handle: QuickJSHandle): QuickJSHandle => {
      handles.push(handle);
      return handle;
    };
    // 不用 unwrapResult/dump：转换不可信异常对象可能触发其 getter 或 toString。
    const unwrap = (
      result: ReturnType<QuickJSContext["evalCode"]>,
      message: string,
    ): QuickJSHandle => {
      if (result.error) {
        result.error.dispose();
        throw check() ?? new Error(message);
      }
      return result.value;
    };
    const fail = (message: string): { error: QuickJSHandle } => ({
      error: vm.newError(stop(message).message),
    });
    const failBridge = keep(
      vm.newFunction("rejectPtc", (message) =>
        fail(message ? vm.getString(message) : "PTC 桥接调用非法"),
      ),
    );
    const submit = keep(
      vm.newFunction("submitTool", (nameHandle, argsHandle) => {
        if (check()) return fail(stopped?.message ?? "PTC 执行已停止");
        const name = nameHandle ? vm.getString(nameHandle) : "";
        if (!names.has(name)) return fail("PTC 工具未获准使用");
        if (calls >= maxCalls) return fail("PTC 工具调用超过次数限额");
        let args: Readonly<Record<string, unknown>>;
        try {
          args = JSON.parse(vm.getString(argsHandle)) as Record<string, unknown>;
          encodeJson(args);
        } catch {
          return fail("PTC 工具参数必须为无损 JSON");
        }
        calls++;
        const deferred = vm.newPromise();
        queue.push({ name, args, deferred });
        // 回调返回值由 QuickJS 绑定释放；保留独立引用供队列结算和统一清理。
        return deferred.handle.dup();
      }),
    );
    const emit = keep(
      vm.newFunction("emitLog", (jsonHandle) => {
        if (check()) return fail(stopped?.message ?? "PTC 执行已停止");
        try {
          const values = JSON.parse(vm.getString(jsonHandle)) as unknown[];
          const text = values
            .map((value) => (typeof value === "string" ? value : encodeJson(value)))
            .join(" ");
          addOutput(`${text}\n`);
          logs.push(text);
        } catch {
          return fail(stopped?.message ?? "PTC 日志必须为无损 JSON");
        }
        return vm.undefined;
      }),
    );
    const bootstrap = keep(
      unwrap(vm.evalCode(BOOTSTRAP, "ptc-bootstrap.js", { type: "global" }), "PTC 初始化失败"),
    );
    const namesJson = keep(vm.newString(JSON.stringify([...names])));
    const bridge = keep(
      unwrap(
        vm.callFunction(bootstrap, vm.undefined, namesJson, submit, emit, failBridge),
        "PTC 初始化失败",
      ),
    );
    const encode = keep(vm.getProp(bridge, "encode"));
    const decode = keep(vm.getProp(bridge, "decode"));
    const program = keep(
      unwrap(
        vm.evalCode(`(async function() {\n"use strict";\n${input.code}\n})()`, "ptc-program.js", {
          type: "global",
        }),
        "PTC JavaScript 语法或执行错误",
      ),
    );

    let cursor = 0;
    let result: PtcProgramResult | undefined;
    while (true) {
      if (check()) throw stopped;
      if (runtime.hasPendingJob()) {
        const jobs = runtime.executePendingJobs(64);
        if (jobs.error) {
          jobs.error.dispose();
          throw check() ?? new Error("PTC JavaScript 异步执行失败");
        }
      }
      if (check()) throw stopped;
      const state = vm.getPromiseState(program);
      if (state.type === "rejected") {
        state.error.dispose();
        throw new Error("PTC JavaScript 执行失败（未捕获异常或工具错误）");
      }
      if (state.type === "fulfilled") {
        if (state.notAPromise) throw new Error("PTC 代码必须为异步函数体");
        try {
          if (!result) {
            result = { logs };
            if (vm.typeof(state.value) !== "undefined") {
              const jsonHandle = unwrap(
                vm.callFunction(encode, vm.undefined, state.value),
                "PTC 返回值必须为无损 JSON",
              );
              try {
                const json = vm.getString(jsonHandle);
                addOutput(json);
                result.value = JSON.parse(json) as unknown;
              } finally {
                jsonHandle.dispose();
              }
            }
          }
        } finally {
          state.value.dispose();
        }
      }
      if (!activeCall && cursor < queue.length) {
        if (check()) throw stopped;
        const call = queue[cursor++];
        if (!call) throw new Error("PTC 工具队列状态非法");
        // 所有宿主调用只在此处启动；取消与发起之间没有 await，保证停止后不启动新调用。
        activeCall = (async () => {
          let value: unknown;
          try {
            value = await input.callTool(call.name, call.args);
          } catch (cause) {
            if (!check()) {
              // 只信任私有登记，不读取异常公开字段，也不让原型链触发宿主访问器或 Proxy。
              const controlled = readPtcToolCallError(cause);
              const error = vm.newError(controlled?.failure.message ?? "PTC 工具调用失败");
              try {
                const code = vm.newString(controlled?.failure.code ?? "TOOL_FAILED");
                try {
                  vm.setProp(error, "code", code);
                } finally {
                  code.dispose();
                }
                const toolName = vm.newString(controlled?.toolName ?? call.name);
                try {
                  vm.setProp(error, "toolName", toolName);
                } finally {
                  toolName.dispose();
                }
                call.deferred.reject(error);
              } finally {
                error.dispose();
              }
            }
            return;
          }
          if (check()) return;
          let json: string;
          try {
            json = encodeJson(value);
          } catch {
            stop("PTC 工具结果必须为无损 JSON");
            return;
          }
          const jsonHandle = vm.newString(json);
          try {
            const valueHandle = unwrap(
              vm.callFunction(decode, vm.undefined, jsonHandle),
              "PTC 工具结果解码失败",
            );
            try {
              call.deferred.resolve(valueHandle);
            } finally {
              valueHandle.dispose();
            }
          } finally {
            jsonHandle.dispose();
          }
        })();
      }
      if (activeCall) {
        await Promise.race([activeCall, stopEvent]);
        if (check()) throw stopped;
        await activeCall;
        activeCall = undefined;
      } else if (result && !runtime.hasPendingJob() && cursor === queue.length) {
        return result;
      } else if (!runtime.hasPendingJob() && cursor === queue.length) {
        // 没有 broker 工作时仍可能等待永不结算的 guest Promise；不能忙等或过早判成功。
        await stopEvent;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    // 即使 guest 已退出或取消，也先收束宿主调用，之后才销毁其仍引用的 VM。
    try {
      await activeCall;
    } finally {
      for (const call of queue) call.deferred.dispose();
      for (let i = handles.length - 1; i >= 0; i--) handles[i]?.dispose();
      context?.dispose();
      runtime?.dispose();
    }
  }
}
