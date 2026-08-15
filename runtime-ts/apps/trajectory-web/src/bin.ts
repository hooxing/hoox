import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevelopmentRuntimeApiMetadataProvider } from "./runtime-metadata.js";
import { startTrajectoryServer } from "./server.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const defaultRoot = fileURLToPath(new URL("../../../../model-wire-traces", import.meta.url));
const root = resolve(argument("--root") ?? defaultRoot);
const portValue = Number(argument("--port") ?? "4188");
const apiOrigin =
  argument("--api-origin") ?? `http://127.0.0.1:${process.env.API_LISTEN_PORT ?? "3001"}`;
const metadata = new DevelopmentRuntimeApiMetadataProvider({ origin: apiOrigin });
const running = await startTrajectoryServer({
  root,
  host: "127.0.0.1",
  port: portValue,
  metadata,
});
console.info(`内部轨迹查看器已启动：${running.url}`);
console.info(`诊断目录：${root}`);

const stop = async () => {
  await running.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
