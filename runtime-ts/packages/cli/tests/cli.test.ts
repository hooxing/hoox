import { describe, expect, it, vi } from "vitest";
import { serializeAgentConfiguration } from "@hoox/protocol";
import { runCli, type CliDependencies } from "../src/cli.js";

const token = "background-credential-placeholder";
const configuration = {
  schemaVersion: 1,
  definition: { id: "agent_example", availability: { mode: "all_tenants" } },
  revision: {
    content: {
      displayName: "示例 Agent",
      description: "配置示例",
      suggestedQuestions: [],
      operatorInstructions: "使用中文回答。",
      replyLanguage: "zh-CN",
      model: { mode: "platform_default" },
      tools: { mode: "platform_default" },
      skillVersions: [],
      includeTenantSkills: false,
      sandboxIdleAction: "pause",
      memory: { mode: "platform_default" },
    },
  },
};
const yaml = serializeAgentConfiguration(configuration);
const draft = { id: "revision_example", definitionId: "agent_example", status: "draft" };
const created = { definition: { id: "agent_example" }, revision: draft };
const envelope = (data: unknown, status = 200) =>
  Response.json({ version: "v1", data }, { status });

function fixture(overrides: CliDependencies = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => envelope(created, 201));
  const readFile = vi.fn(async () => yaml);
  const writeFile = vi.fn(async () => undefined);
  const dependencies: CliDependencies = {
    env: { HOOX_URL: "https://control.example.invalid", HOOX_TOKEN: token },
    fetcher,
    readFile,
    writeFile,
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
    sleep: async () => undefined,
    ...overrides,
  };
  return {
    fetcher,
    readFile,
    writeFile,
    output,
    errors,
    dependencies,
    run: (args: string[]) => runCli(args, dependencies),
    result: () => JSON.parse(output.join("")) as Record<string, unknown>,
  };
}

describe("hoox 命令行", () => {
  it("validate 使用共享解析器，完全离线且不读取令牌文件或环境配置", async () => {
    const context = fixture({ env: {} });
    expect(await context.run(["validate", "agent.yaml", "--json", "--token-file", "unused"])).toBe(
      0,
    );
    expect(context.result()).toEqual({ ok: true, valid: true, source: "local" });
    expect(context.fetcher).not.toHaveBeenCalled();
    expect(context.readFile).toHaveBeenCalledTimes(1);
    expect(context.readFile).toHaveBeenCalledWith("agent.yaml", 1_048_576);
  });

  it("本地校验返回字段路径与退出码 2，机器输出只有一条 JSON", async () => {
    const context = fixture({ readFile: async () => "schemaVersion: 2\n" });
    expect(await context.run(["validate", "agent.yaml", "--json"])).toBe(2);
    expect(context.result()).toMatchObject({
      ok: false,
      error: {
        kind: "validation",
        errors: [{ path: "/schemaVersion", code: "UNKNOWN_SCHEMA_VERSION" }],
      },
    });
    expect(context.errors).toEqual([]);
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["unknown", "agent.yaml"],
    ["validate"],
    ["pull", "../traversal"],
    ["push", "agent.yaml", "--revision", "revision_example"],
    ["pull", "agent_example", "--remote"],
    ["validate", "agent.yaml", "--dry-run"],
    ["push", "agent.yaml", "--definition", "agent_example"],
    ["push", "agent.yaml", "--expected-generation", "1"],
    ["push", "agent.yaml", "--definition", "agent_example", "--expected-generation", "-1"],
    [
      "push",
      "agent.yaml",
      "--definition",
      "agent_example",
      "--expected-generation",
      "9007199254740992",
    ],
    ["push", "agent.yaml", "--definition", "agent_example", "--expected-generation", "1e2"],
    ["push", "agent.yaml", "--json", "--json"],
    ["push", "agent.yaml", "--token", token],
  ])("参数错误退出 1 且不联网：%j", async (...args: string[]) => {
    const context = fixture();
    expect(await context.run([...args, "--json"])).toBe(1);
    expect(context.result()).toMatchObject({ error: { kind: "usage" } });
    expect(context.fetcher).not.toHaveBeenCalled();
    expect(context.output.join("")).not.toContain(token);
  });

  it("帮助不要求文件、URL 或凭据", async () => {
    const context = fixture({ env: {} });
    expect(await context.run(["--help"])).toBe(0);
    expect(context.output.join("")).toContain("hoox push");
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it.each(["validate", "push"])("%s 的远程 dry-run 不创建草稿", async (command) => {
    const context = fixture();
    context.fetcher.mockResolvedValue(envelope({ valid: true }));
    expect(
      await context.run([
        command,
        "agent.yaml",
        command === "push" ? "--dry-run" : "--remote",
        "--json",
      ]),
    ).toBe(0);
    const request = context.fetcher.mock.calls[0];
    expect(String(request?.[0])).toBe(
      "https://control.example.invalid/v1/admin/control/agent-definitions/import",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ yaml, dryRun: true });
    expect(request?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(context.result()).toEqual({ ok: true, valid: true, source: "remote" });
  });

  it("远程校验返回路径化错误并脱敏服务端消息", async () => {
    const context = fixture();
    context.fetcher.mockResolvedValue(
      envelope({
        valid: false,
        errors: [
          {
            path: "/revision/content/model",
            code: "REFERENCE_INVALID",
            message: `not found ${token}`,
          },
        ],
      }),
    );
    expect(await context.run(["validate", "agent.yaml", "--remote", "--json"])).toBe(2);
    expect(context.output.join("")).not.toContain(token);
    expect(context.result()).toMatchObject({
      error: { errors: [{ path: "/revision/content/model" }] },
    });
  });

  it("push 新建草稿输出两个 ID，网络异常和 503 重试复用幂等键与请求字节", async () => {
    const context = fixture();
    context.fetcher
      .mockRejectedValueOnce(new Error(token))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(envelope(created, 201));
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(0);
    expect(context.result()).toMatchObject({
      definitionId: "agent_example",
      revisionId: "revision_example",
      status: "draft",
    });
    expect(context.fetcher).toHaveBeenCalledTimes(3);
    const requests = context.fetcher.mock.calls.map((call) => call[1]);
    expect(new Set(requests.map((request) => request?.body)).size).toBe(1);
    const keys = requests.map((request) => new Headers(request?.headers).get("idempotency-key"));
    expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set(keys).size).toBe(1);
    expect(context.result().idempotencyKey).toBe(keys[0]);
    expect(context.output.join("")).not.toContain(token);
  });

  it("push 追加传递 generation，不发布且解析单个 Revision 响应", async () => {
    const context = fixture();
    context.fetcher.mockResolvedValue(envelope(draft, 201));
    expect(
      await context.run([
        "push",
        "agent.yaml",
        "--definition",
        "agent_example",
        "--expected-generation",
        "7",
        "--json",
      ]),
    ).toBe(0);
    expect(String(context.fetcher.mock.calls[0]?.[0])).toContain("/agent_example/import");
    expect(JSON.parse(String(context.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      yaml,
      dryRun: false,
      expectedGeneration: 7,
    });
    expect(context.result()).toMatchObject({ revisionId: "revision_example" });
    expect(context.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("认证/授权 %i 退出 3、不重试、不回显响应与令牌", async (status) => {
    const context = fixture();
    context.fetcher.mockResolvedValue(new Response(token, { status }));
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(3);
    expect(context.fetcher).toHaveBeenCalledTimes(1);
    expect(context.output.join("")).not.toContain(token);
  });

  it.each([false, true])("pull 不读取网关 401 的正文（JSON=%s）", async (json) => {
    const context = fixture();
    const cancel = vi.fn(() => Promise.reject(new Error("上游已断开")));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6_500_001));
      },
      cancel,
    });
    context.fetcher.mockResolvedValue(
      new Response(body, { status: 401, headers: { "content-type": "text/html" } }),
    );
    expect(await context.run(["pull", "agent_example", ...(json ? ["--json"] : [])])).toBe(3);
    expect(context.fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    if (json) expect(context.result()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    else expect(context.errors.join("")).toMatch(/^UNAUTHORIZED:/u);
  });

  it("网关 HTML 5xx 按 HTTP 状态归类为服务错误而非无效响应", async () => {
    const context = fixture();
    const cancel = vi.fn(() => Promise.reject(new Error("上游已断开")));
    const response = () =>
      new Response("<html>upstream unavailable</html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    context.fetcher.mockImplementation(async () => {
      const value = response();
      Object.defineProperty(value.body, "cancel", { value: cancel });
      return value;
    });
    expect(await context.run(["pull", "agent_example", "--json"])).toBe(4);
    expect(context.fetcher).toHaveBeenCalledTimes(3);
    expect(context.result()).toMatchObject({
      error: { kind: "service", code: "HTTP_ERROR" },
    });
    expect(context.output.join("")).not.toContain("INVALID_RESPONSE");
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("缺凭据退出 3；token-file 优先于环境变量且只读取一次", async () => {
    const missing = fixture({ env: { HOOX_URL: "https://control.example.invalid" } });
    expect(await missing.run(["pull", "agent_example", "--json"])).toBe(3);
    expect(missing.fetcher).not.toHaveBeenCalled();
    const context = fixture({
      readFile: async (path) => (path === "token.txt" ? "file-token-placeholder\n" : yaml),
    });
    expect(await context.run(["push", "agent.yaml", "--token-file", "token.txt", "--json"])).toBe(
      0,
    );
    expect(context.fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer file-token-placeholder",
    });
    expect(context.output.join("")).not.toContain("file-token-placeholder");
  });

  it("token-file 凭据不会被本地校验的字段路径回显", async () => {
    const secret = "file-only-token-placeholder";
    const context = fixture({
      readFile: async (path) => (path === "token.txt" ? secret : `${yaml}${secret}: true\n`),
    });
    expect(await context.run(["push", "agent.yaml", "--token-file", "token.txt", "--json"])).toBe(
      2,
    );
    expect(context.output.join("")).not.toContain(secret);
    expect(context.result()).toMatchObject({ error: { errors: [{ path: "配置" }] } });
    expect(context.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@example.invalid",
    "http://example.invalid",
    "https://example.invalid/path",
    "https://example.invalid?token=secret",
    "invalid",
  ])("拒绝不安全或不明确的后台 origin", async (url) => {
    const context = fixture({ env: { HOOX_URL: url, HOOX_TOKEN: token } });
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(1);
    expect(context.fetcher).not.toHaveBeenCalled();
    expect(context.output.join("")).not.toContain(url);
  });

  it.each([400, 404, 409, 422])("客户端 HTTP %i 是校验失败，不重试", async (status) => {
    const context = fixture();
    context.fetcher.mockResolvedValue(
      Response.json(
        { validationErrors: [{ path: "/definition/id", code: "INVALID", message: token }] },
        { status },
      ),
    );
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(2);
    expect(context.fetcher).toHaveBeenCalledTimes(1);
    expect(context.output.join("")).not.toContain(token);
  });

  it("上游字段错误只输出验证过的路径和固定文案，不回显控制字符或未知消息", async () => {
    for (const args of [
      ["push", "agent.yaml", "--json"],
      ["push", "agent.yaml"],
    ]) {
      const context = fixture();
      context.fetcher.mockResolvedValue(
        Response.json(
          {
            validationErrors: [
              { path: "/definition/id", code: "INVALID", message: "\u001b[31mOWNED\nforged\u0000" },
              { path: "/definition/\u001b[2J", code: "INVALID", message: "bad path" },
              {
                path: "/definition/name",
                code: "NEW_SECRET_CODE",
                message: "arbitrary upstream text",
              },
            ],
          },
          { status: 422 },
        ),
      );
      expect(await context.run(args)).toBe(2);
      const output = `${context.output.join("")}\n${context.errors.join("")}`;
      expect(output).toContain("/definition/id");
      expect(output).toContain("字段值无效");
      expect(output).toContain("INVALID_VALUE");
      expect(output).toContain("另有字段未通过校验");
      expect(output).not.toContain("OWNED");
      expect(output).not.toContain("forged");
      expect(output).not.toContain("arbitrary upstream text");
      expect(output).not.toContain("bad path");
      expect(output).not.toContain("\u001b");
    }
  });

  it("网络失败退出 4、有限重试，底层异常不进入输出", async () => {
    const context = fixture();
    context.fetcher.mockRejectedValue(new Error(`network ${token}`));
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(4);
    expect(context.fetcher).toHaveBeenCalledTimes(3);
    expect(context.output.join("")).not.toContain(token);
  });

  it.each([
    "<html>broken</html>",
    JSON.stringify({ data: null }),
    JSON.stringify({ data: created.revision }),
  ])("无效后台响应退出 4，不回显原文", async (body) => {
    const context = fixture();
    context.fetcher.mockResolvedValue(new Response(body));
    expect(await context.run(["push", "agent.yaml", "--json"])).toBe(4);
  });

  it("pull 默认选择当前已发布 Revision，标准输出保留 YAML 原字节", async () => {
    const context = fixture();
    context.fetcher
      .mockResolvedValueOnce(envelope({ definition: { currentRevisionId: "revision_published" } }))
      .mockResolvedValueOnce(
        new Response(yaml, { headers: { "content-type": "application/yaml; charset=utf-8" } }),
      );
    expect(await context.run(["pull", "agent_example"])).toBe(0);
    expect(context.output.join("")).toBe(yaml);
    expect(String(context.fetcher.mock.calls[1]?.[0])).toContain("/revision_published/export");
  });

  it("pull 指定 Revision 不查询当前版本，JSON 包含 YAML，-o 写入相同字节", async () => {
    const context = fixture();
    context.fetcher.mockImplementation(
      async () => new Response(yaml, { headers: { "content-type": "application/yaml" } }),
    );
    expect(
      await context.run(["pull", "agent_example", "--revision", "revision_example", "--json"]),
    ).toBe(0);
    expect(context.result().yaml).toBe(yaml);
    context.output.length = 0;
    expect(
      await context.run([
        "pull",
        "agent_example",
        "--revision",
        "revision_example",
        "-o",
        "out.yaml",
        "--json",
      ]),
    ).toBe(0);
    expect(context.writeFile).toHaveBeenCalledWith("out.yaml", yaml);
    expect(context.result()).toMatchObject({ output: "out.yaml" });
  });

  it("没有已发布版本时不偷偷导出最新草稿", async () => {
    const context = fixture();
    context.fetcher.mockResolvedValue(envelope({ definition: {} }));
    expect(await context.run(["pull", "agent_example", "--json"])).toBe(2);
    expect(context.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "pull 导出含未知键的 YAML 返回固定 INVALID_RESPONSE（JSON=%s）",
    async (json) => {
      const context = fixture();
      const upstreamUnknownKey = "upstreamOnlySecretKey";
      context.fetcher.mockResolvedValue(
        new Response(`${yaml}\n${upstreamUnknownKey}: true\n`, {
          headers: { "content-type": "application/yaml" },
        }),
      );
      expect(
        await context.run([
          "pull",
          "agent_example",
          "--revision",
          "revision_example",
          ...(json ? ["--json"] : []),
        ]),
      ).toBe(4);
      if (json) {
        expect(context.result()).toMatchObject({
          error: {
            kind: "service",
            code: "INVALID_RESPONSE",
            message: "后台返回了无效响应",
            errors: [],
          },
        });
      } else {
        expect(context.errors.join("")).toContain("INVALID_RESPONSE: 后台返回了无效响应");
      }
      expect(`${context.output.join("")}\n${context.errors.join("")}`).not.toContain(
        upstreamUnknownKey,
      );
      expect(context.output.join("")).not.toContain("Unexpected property");
    },
  );

  it("拒绝导出包含令牌的 YAML，不写入文件或标准输出", async () => {
    const context = fixture();
    context.fetcher.mockResolvedValue(
      new Response(yaml.replace("配置示例", token), {
        headers: { "content-type": "application/yaml" },
      }),
    );
    expect(
      await context.run([
        "pull",
        "agent_example",
        "--revision",
        "revision_example",
        "-o",
        "out.yaml",
        "--json",
      ]),
    ).toBe(4);
    expect(context.output.join("")).not.toContain(token);
    expect(context.writeFile).not.toHaveBeenCalled();
  });

  it("读写失败退出 5，底层路径或错误消息不泄漏", async () => {
    const reading = fixture({
      readFile: async () => {
        throw new Error(token);
      },
    });
    expect(await reading.run(["validate", "missing.yaml", "--json"])).toBe(5);
    expect(reading.output.join("")).not.toContain(token);
    const writing = fixture({
      writeFile: async () => {
        throw new Error(token);
      },
    });
    writing.fetcher.mockResolvedValue(
      new Response(yaml, { headers: { "content-type": "application/yaml" } }),
    );
    expect(
      await writing.run([
        "pull",
        "agent_example",
        "--revision",
        "revision_example",
        "-o",
        "out.yaml",
        "--json",
      ]),
    ).toBe(5);
    expect(writing.output.join("")).not.toContain(token);
  });
});
