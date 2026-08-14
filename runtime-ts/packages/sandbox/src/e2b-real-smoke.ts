import { e2bConfigFromEnv, E2BSandboxGateway } from "./index.js";

const configuration = e2bConfigFromEnv(process.env);
const gateway = new E2BSandboxGateway({
  apiKey: configuration.apiKey,
  ...(configuration.domain === undefined ? {} : { domain: configuration.domain }),
  defaultOperationTimeoutMs: 90_000,
});

const sandbox = await gateway.create({
  templateId: configuration.templateId,
  ttlSeconds: 300,
});
try {
  const command = await sandbox.command("printf 'e2b-command-ok'");
  if (command.exitCode !== 0 || command.stdout !== "e2b-command-ok") {
    throw new Error("E2B command 冒烟失败");
  }
  await sandbox.writeFile("/tmp/e2b-runtime-smoke.txt", "e2b-files-ok");
  if ((await sandbox.readFile("/tmp/e2b-runtime-smoke.txt")) !== "e2b-files-ok") {
    throw new Error("E2B files 冒烟失败");
  }
  if ((await gateway.inspect(sandbox.id)) !== "running") {
    throw new Error("E2B inspect 冒烟失败");
  }
  await sandbox.pause();
  if ((await gateway.inspect(sandbox.id)) !== "paused") {
    throw new Error("E2B pause 冒烟失败");
  }
  const resumed = await gateway.connect(sandbox.id);
  const resumedCommand = await resumed.command("printf 'e2b-connect-ok'");
  if (resumedCommand.exitCode !== 0 || resumedCommand.stdout !== "e2b-connect-ok") {
    throw new Error("E2B connect 冒烟失败");
  }
  process.stdout.write("E2B create/command/files/inspect/pause/connect 冒烟通过\n");
} finally {
  await sandbox.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
}
