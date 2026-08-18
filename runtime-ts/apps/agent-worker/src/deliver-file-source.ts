import type { DeliverFileSessionBinding, DeliverFileSourcePort } from "@hoox/tool-router";
import { type SandboxWorkspacePort, workspaceRelativePath } from "@hoox/workspace";

/** 把 deliver_file 的绝对路径收窄为当前 CubeSandbox 的 /workspace 二进制读取。 */
export class SandboxDeliverFileSource implements DeliverFileSourcePort {
  constructor(
    private readonly openWorkspace: (input: {
      readonly binding: DeliverFileSessionBinding;
      readonly signal?: AbortSignal;
    }) => Promise<SandboxWorkspacePort>,
    private readonly maxBytes: number,
  ) {}

  async read(input: Parameters<DeliverFileSourcePort["read"]>[0]) {
    const relativePath = normalizeAbsolutePath(input.absolutePath);
    const workspace = await this.openWorkspace({
      binding: input.binding,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const session = await workspace.currentSession();
    if (session.sessionId !== input.binding.sandbox.providerSandboxId) {
      return { outcome: "unavailable" as const };
    }
    const inspected = await workspace.inspectRegularFile(
      session,
      relativePath,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (inspected.status === "missing") return { outcome: "not_found" as const };
    if (inspected.status !== "regular") return { outcome: "not_regular" as const };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of inspected.body) {
      if (!(chunk instanceof Uint8Array) || size > this.maxBytes - chunk.byteLength) {
        return { outcome: "unavailable" as const };
      }
      size += chunk.byteLength;
      chunks.push(Uint8Array.from(chunk));
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Object.freeze({ outcome: "found" as const, relativePath, body });
  }
}

function normalizeAbsolutePath(path: string): string {
  if (!path.startsWith("/workspace/")) throw new TypeError("DELIVER_FILE_PATH_INVALID");
  return workspaceRelativePath(path.slice("/workspace/".length));
}
