import { CubeSandboxGateway, cubeConfigFromEnv, type SandboxHandle } from "@hoox/sandbox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
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

  console.log("[2/6] 创建 Pi Session 与 Faux Provider（工具在 Linux CubeSandbox 执行）");
  const faux = fauxProvider({
    api: "faux-real-cube-smoke",
    provider: "faux-real-cube-smoke",
    tokensPerSecond: 10_000,
  });
  let writeObservationSeen = false;
  let readObservationSeen = false;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("exec_command", { cmd: `printf %s '${content}' > '${path}'` }),
      {
        stopReason: "toolUse",
      },
    ),
    (context) => {
      const messages = JSON.stringify(context.messages);
      writeObservationSeen = messages.includes('\\"exit_code\\":0');
      return fauxAssistantMessage(fauxToolCall("exec_command", { cmd: `cat '${path}'` }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      const messages = JSON.stringify(context.messages);
      readObservationSeen = messages.includes('\\"exit_code\\":0') && messages.includes(content);
      return fauxAssistantMessage("真实纵向链路完成");
    },
  ]);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "api_key",
    key: "test-only-key",
  }));
  const modelRuntime = createModels({ credentials });
  modelRuntime.setProvider(faux.provider);
  const authorizedCalls: Array<{ callId: string; toolName: string; argsDigest: string }> = [];
  const model = faux.getModel();
  controller = await createSafePiSession({
    model,
    modelContext: bindTrustedPiModelContextCapability(modelRuntime, model),
    modelRuntime,
    sandbox,
    authorizeToolEffect: async (call) => {
      authorizedCalls.push(call);
      return {
        consumedAtMonotonicMs: performance.now(),
        maxContinuationDelayMs: 250,
      };
    },
    createToolObservationRecorder: (outputs) => ({
      record: async (call) => {
        const observation = await outputs.readControlledReceipt(call);
        return observation === undefined
          ? { outcome: "conflict" as const }
          : { outcome: "recorded" as const, observation, isTruncated: false };
      },
    }),
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
    authorizedCalls.map((call) => call.toolName).join(",") === "exec_command,exec_command",
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
