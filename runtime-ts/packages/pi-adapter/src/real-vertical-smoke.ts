import { CubeSandboxGateway, cubeConfigFromEnv, type SandboxHandle } from "@cube-runtime/sandbox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  type PiSessionController,
} from "./pi-session.js";

if (process.env.REAL_PI_CUBE_SMOKE !== "1") {
  throw new Error("真实 Pi + Cube 纵向冒烟默认关闭；请显式设置 REAL_PI_CUBE_SMOKE=1");
}

const config = cubeConfigFromEnv(process.env);
const gateway = new CubeSandboxGateway({ ...config, defaultOperationTimeoutMs: 90_000 });
const path = `/tmp/pi-cube-vertical-${Date.now()}.txt`;
const content = `pi-cube-observation-${Date.now()}`;
let sandbox: SandboxHandle | undefined;
let controller: PiSessionController | undefined;

try {
  console.log("[1/6] 创建真实 CubeSandbox");
  sandbox = await gateway.create({ templateId: config.templateId, ttlSeconds: 120 });

  console.log("[2/6] 创建 Linux Pi Session 与 Faux Provider");
  const faux = fauxProvider({
    api: "faux-real-cube-smoke",
    provider: "faux-real-cube-smoke",
    tokensPerSecond: 10_000,
  });
  let writeObservationSeen = false;
  let readObservationSeen = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("sandbox_write_file", { path, content }), {
      stopReason: "toolUse",
    }),
    (context) => {
      const messages = JSON.stringify(context.messages);
      writeObservationSeen = messages.includes("written") && messages.includes("true");
      return fauxAssistantMessage(fauxToolCall("sandbox_read_file", { path }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      readObservationSeen = JSON.stringify(context.messages).includes(content);
      return fauxAssistantMessage("真实纵向链路完成");
    },
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
  const authorizedCalls: Array<{ callId: string; toolName: string; argsDigest: string }> = [];
  const model = faux.getModel();
  controller = await createSafePiSession({
    model,
    modelContext: bindTrustedPiModelContextCapability(model),
    modelRuntime,
    sandbox,
    authorizeToolEffect: async (call) => {
      authorizedCalls.push(call);
      return {
        consumedAtMonotonicMs: performance.now(),
        maxContinuationDelayMs: 250,
      };
    },
  });

  console.log("[3/6] Faux Provider 发起 Pi Tool Call");
  const events: string[] = [];
  controller.subscribe((event) => events.push(event.type));
  await controller.prompt("在隔离环境写入文件、读回并确认结果");

  console.log("[4/6] 验证 Observation 返回模型");
  assert(writeObservationSeen, "模型没有收到写入 Observation");
  assert(readObservationSeen, "模型没有收到读取 Observation");
  assert(events.filter((event) => event === "tool.completed").length === 2, "工具终态数量错误");
  assert(
    authorizedCalls.map((call) => call.toolName).join(",") ===
      "sandbox_write_file,sandbox_read_file",
    "工具许可没有逐调用绑定真实工具名",
  );
  assert(new Set(authorizedCalls.map((call) => call.callId)).size === 2, "工具许可 callId 未隔离");
  assert(
    authorizedCalls.every((call) => /^[a-f0-9]{64}$/u.test(call.argsDigest)),
    "工具许可参数摘要格式错误",
  );
  assert(events.at(-1) === "agent.settled", "Agent 未进入 settled");

  console.log("[5/6] 旁路验证真实 Sandbox 文件结果");
  assert((await sandbox.readFile(path)) === content, "Sandbox 文件内容不符合预期");
  console.log("[6/6] Pi + Cube 纵向冒烟通过，进入 finally 清理");
} finally {
  controller?.dispose();
  if (sandbox) await sandbox.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
