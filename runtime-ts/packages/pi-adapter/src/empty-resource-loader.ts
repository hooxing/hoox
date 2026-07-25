import {
  createExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * 服务端 Agent 的零发现资源加载器。
 *
 * 它不接收宿主路径，也不调用文件系统或 PackageManager。后续租户 Skill 必须经过自有
 * Resource 服务过滤后显式注入，不能退回 Pi 的项目目录自动发现。
 */
export class EmptyResourceLoader implements ResourceLoader {
  readonly #extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  constructor(private readonly systemPrompt: string) {}

  getExtensions(): LoadExtensionsResult {
    return this.#extensions;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    return [];
  }

  extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    // 零发现实现刻意忽略 Pi 扩展提出的资源路径，防止绕过 Runtime 资源授权。
  }

  async reload(): Promise<void> {
    // 无 I/O、无发现，reload 是确定性的空操作。
  }
}
