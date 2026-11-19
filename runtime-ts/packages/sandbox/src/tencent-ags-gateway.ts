import type { SandboxInfo } from "e2b";
import { E2BSandboxGateway, type E2BGatewayOptions, type E2BSdkFacade } from "./e2b-gateway.js";
import { reusableE2BSdk } from "./e2b-handle-sdk.js";
import { SandboxRuntimeError } from "./errors.js";
import type { OperationControl, SandboxCreateInput, SandboxHandle } from "./types.js";
import type {
  SandboxWorkspaceAdapterOptions,
  TrustedSandboxSessionCapability,
} from "./workspace-adapter.js";
import { resolveTrustedSandboxWorkspaceBinding } from "./workspace-adapter.js";
import { validateTimeout } from "./validation.js";

export interface TencentAgsGatewayOptions extends E2BGatewayOptions {
  readonly domain: string;
}

/** AGS 使用独立持久身份；E2B 兼容协议不代表生命周期和挂载扩展兼容。 */
export class TencentAgsSandboxGateway extends E2BSandboxGateway {
  override readonly providerKey = "tencent-ags" as const;
  protected override readonly preserveMemoryOnPause = false;
  private readonly operationTimeoutMs: number;

  constructor(options: TencentAgsGatewayOptions, sdk?: E2BSdkFacade) {
    if (!options.domain?.trim()) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "腾讯云 AGS Domain 不能为空");
    }
    super(options, sdk);
    this.operationTimeoutMs = options.defaultOperationTimeoutMs ?? 60_000;
  }

  override async create(input: SandboxCreateInput, control: OperationControl = {}) {
    if (input.lifecycle?.onTimeout === "pause" || input.lifecycle?.autoResume === true) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "腾讯云 AGS 不承诺到期自动暂停或自动恢复");
    }
    if (input.volumeMounts !== undefined && input.volumeMounts.length > 0) {
      throw new SandboxRuntimeError(
        "INVALID_ARGUMENT",
        "腾讯云 AGS 使用 ResourceFS 快照，不支持 Cube Volume",
      );
    }
    // 不向兼容接口发送未确认支持的生命周期或 Volume 扩展；到期销毁由 AGS TTL 控制。
    const { lifecycle: _lifecycle, volumeMounts: _volumeMounts, ...request } = input;
    return super.create(request, control);
  }

  override async connect(id: string, control: OperationControl = {}) {
    const remaining = this.operationBudget(control);
    await this.assertConnectable(id, remaining());
    const sandbox = await super.connect(id, remaining());
    await this.assertRunning(id, remaining());
    return sandbox;
  }

  override async connectWorkspace(
    capability: TrustedSandboxSessionCapability,
    options: SandboxWorkspaceAdapterOptions,
    control: OperationControl = {},
    reuse?: SandboxHandle,
  ) {
    const remaining = this.operationBudget(control);
    const binding = await resolveTrustedSandboxWorkspaceBinding(
      capability,
      remaining().timeoutMs,
      control.signal,
    );
    // 复用 Run 已连接且已确认 running 的 Handle 时不会触发自动恢复，无需重复状态校验。
    if (reusableE2BSdk(reuse, binding.sessionId) !== undefined) {
      return super.connectWorkspace(capability, options, remaining(), reuse);
    }
    await this.assertConnectable(binding.sessionId, remaining());
    const workspace = await super.connectWorkspace(capability, options, remaining());
    await this.assertRunning(binding.sessionId, remaining());
    return workspace;
  }

  private operationBudget(control: OperationControl) {
    validateTimeout(control.timeoutMs);
    const deadline = Date.now() + (control.timeoutMs ?? this.operationTimeoutMs);
    // 状态校验与连接共用预算，不能把 Scheduler 租约假定的一次连接放大成多倍超时。
    return () => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new SandboxRuntimeError("TIMEOUT", "腾讯云 AGS 连接预算已耗尽");
      return { ...control, timeoutMs };
    };
  }

  private async assertConnectable(id: string, control: OperationControl) {
    const state = await this.inspect(id, control);
    if (state === "not_found")
      throw new SandboxRuntimeError("NOT_FOUND", "腾讯云 AGS 实例已终止或不存在");
    if (state === "unknown")
      throw new SandboxRuntimeError("UNKNOWN", "腾讯云 AGS 实例尚未确认可连接");
  }

  private async assertRunning(id: string, control: OperationControl) {
    if ((await this.inspect(id, control)) !== "running") {
      throw new SandboxRuntimeError("UNKNOWN", "腾讯云 AGS 连接后尚未确认运行，保留实例等待对账");
    }
  }

  protected override inspectInfo(
    info: SandboxInfo,
  ): "running" | "paused" | "not_found" | "unknown" {
    const state = info.metadata?.["x-ags-sandbox-state"];
    if (state === undefined) return super.inspectInfo(info);
    if (state === "running" || state === "paused") return state;
    if (state === "stopped" || state === "failed" || state === "starting_failed")
      return "not_found";
    // 过渡态及恢复失败保留远端身份，禁止根据兼容 state 字段误判可复用或重新创建。
    return "unknown";
  }
}
