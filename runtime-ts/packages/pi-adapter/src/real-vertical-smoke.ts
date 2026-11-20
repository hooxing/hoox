import { DEFAULT_AGENT_OPERATOR_INSTRUCTIONS } from "@hoox/prompt-builder";
import {
  CubeSandboxGateway,
  cubeConfigFromEnv,
  E2BSandboxGateway,
  e2bConfigFromEnv,
  type SandboxGateway,
  type SandboxHandle,
} from "@hoox/sandbox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type Context,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  bindTrustedPiModelContextCapability,
  createSafePiSession,
  type PiSessionController,
} from "./pi-session.js";

const useE2B = process.argv.includes("--e2b");
if (!useE2B && process.env.REAL_PI_CUBE_SMOKE !== "1") {
  throw new Error("真实 Pi 纵向冒烟默认关闭；请传入 --e2b 或设置 REAL_PI_CUBE_SMOKE=1");
}

const providerName = useE2B ? "E2B" : "CubeSandbox";
let gateway: SandboxGateway;
let templateId: string;
if (useE2B) {
  const config = e2bConfigFromEnv(process.env);
  gateway = new E2BSandboxGateway({ ...config, defaultOperationTimeoutMs: 90_000 });
  templateId = config.templateId;
} else {
  const config = cubeConfigFromEnv(process.env);
  gateway = new CubeSandboxGateway({ ...config, defaultOperationTimeoutMs: 90_000 });
  templateId = config.templateId;
}
const path = `/tmp/pi-vertical-${Date.now()}.txt`;
const content = `pi-observation-${Date.now()}`;
let sandbox: SandboxHandle | undefined;
let controller: PiSessionController | undefined;

try {
  console.log(`[1/6] 创建真实 ${providerName}`);
  sandbox = await gateway.create({ templateId, ttlSeconds: 120 });
  if (useE2B) {
    // 独立冒烟没有 Worker registry；按其 E2B 基线准备普通用户拥有的工作目录。
    const preparation = await sandbox.command(
      'set -eu\n[ ! -L /workspace ]\nsudo install -d -o "$(id -u)" -g "$(id -g)" -m 0700 /workspace\n[ -d /workspace ]\n[ ! -L /workspace ]',
    );
    assert(preparation.exitCode === 0 && preparation.stderr === "", "冒烟夹具无法准备 /workspace");
  }

  console.log(`[2/6] 创建 Pi Session 与 Faux Provider（工具在 Linux ${providerName} 执行）`);
  const faux = fauxProvider({
    api: "faux-real-sandbox-smoke",
    provider: "faux-real-sandbox-smoke",
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
      writeObservationSeen = commandObservationMatches(context, "");
      return fauxAssistantMessage(fauxToolCall("exec_command", { cmd: `cat '${path}'` }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      readObservationSeen = commandObservationMatches(context, content);
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
    operatorInstructions: DEFAULT_AGENT_OPERATOR_INSTRUCTIONS,
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
  console.log(`[6/6] Pi + ${providerName} 纵向冒烟通过，进入 finally 清理`);
} finally {
  controller?.dispose();
  if (sandbox) {
    await sandbox.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
    console.log("真实 Sandbox 清理完成");
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function commandObservationMatches(context: Context, stdout: string): boolean {
  const result = context.messages.at(-1);
  if (result?.role !== "toolResult" || result.toolName !== "exec_command" || result.isError) {
    return false;
  }
  // 只检查模型收到的最新工具结果，避免命令参数中的预期文本造成假阳性。
  return result.content.some((block) => {
    if (block.type !== "text") return false;
    const output = JSON.parse(block.text) as { exit_code?: unknown; stdout?: unknown };
    return output.exit_code === 0 && output.stdout === stdout;
  });
}
