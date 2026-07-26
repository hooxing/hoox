import {
  integerEnvironmentField,
  parseStrictEnvironment,
  readRequiredEnvironmentValue,
  startServiceProcess,
} from "./process-runtime/index.js";

const parsed = parseStrictEnvironment(
  {
    RUNTIME_ENV: process.env.RUNTIME_ENV,
    PROCESS_SHUTDOWN_TIMEOUT_MS: process.env.PROCESS_SHUTDOWN_TIMEOUT_MS,
  },
  {
    PROCESS_SHUTDOWN_TIMEOUT_MS: integerEnvironmentField({ minimum: 1, maximum: 10_000 }),
  },
);

const shutdownTimeoutMilliseconds = readRequiredEnvironmentValue(
  parsed,
  "PROCESS_SHUTDOWN_TIMEOUT_MS",
);
const events = [];
const service = await startServiceProcess({
  serviceName: "container-gate",
  configuration: Object.freeze({ runtimeEnvironment: parsed.runtimeEnvironment }),
  shutdownTimeoutMilliseconds,
  assembler: {
    async assemble() {
      return {
        stopAccepting: async () => events.push("stop"),
        readiness: [{ name: "gate", probe: async () => undefined }],
        resources: [{ name: "gate", close: async () => events.push("close") }],
      };
    },
  },
});

if ((await service.readiness()).status !== "ready") throw new Error("CONTAINER_GATE_NOT_READY");
await service.close();
if (events.join(",") !== "stop,close") throw new Error("CONTAINER_GATE_CLOSE_ORDER_INVALID");
console.log("process-container-gate:ok");
