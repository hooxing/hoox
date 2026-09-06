import { describe, expect, it, vi } from "vitest";
import { checkDemoRelease } from "../../scripts/demo-release-gate.mjs";

const sha = "a".repeat(40);
const repository = "example/hoox";
const success = {
  id: 12,
  event: "push",
  head_branch: "main",
  head_sha: sha,
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
};
const input = {
  eventName: "workflow_run",
  event: { workflow_run: success },
  repository,
  ref: "refs/heads/main",
  sha,
  token: "test-placeholder-token",
};

function github(runs: unknown[] = [success], head = sha) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ object: { sha: head } }))
    .mockResolvedValueOnce(Response.json({ workflow_runs: runs }));
}

describe("Demo 发布提交门禁", () => {
  it.each(["workflow_run", "workflow_dispatch"])("%s 发布 main 当前绿色提交", async (eventName) => {
    const fetchImpl = github();
    const result = await checkDemoRelease({ ...input, eventName, fetchImpl });
    expect(result).toMatchObject({ shouldDeploy: true, releaseSha: sha });
    const [url, options] = fetchImpl.mock.calls[1] ?? [];
    expect(url).toBe(
      `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
    );
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("不发布已经离开 main HEAD 的提交，也不继续查询 CI", async () => {
    const fetchImpl = github([], "b".repeat(40));
    expect(await checkDemoRelease({ ...input, fetchImpl })).toMatchObject({
      shouldDeploy: false,
      releaseSha: sha,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { event: "pull_request" },
    { head_branch: "feature" },
    { head_repository: { full_name: "external/hoox" } },
    { head_repository: null },
    { conclusion: "failure" },
  ])("自动触发拒绝非受信任 CI 来源：%j", async (changes) => {
    const fetchImpl = github();
    await expect(
      checkDemoRelease({
        ...input,
        event: { workflow_run: { ...success, ...changes } },
        fetchImpl,
      }),
    ).rejects.toThrow("只接受本仓库 main push 的成功 CI");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("手工入口不能绕过分支限制", async () => {
    const fetchImpl = github();
    await expect(
      checkDemoRelease({
        ...input,
        eventName: "workflow_dispatch",
        ref: "refs/heads/feature",
        fetchImpl,
      }),
    ).rejects.toThrow("只允许 main 分支");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ ...success, status: "in_progress", conclusion: null }],
    [{ ...success, conclusion: "failure" }],
    [{ ...success, head_sha: "b".repeat(40) }],
    [{ ...success, event: "pull_request" }],
    [{ ...success, head_repository: { full_name: "external/hoox" } }],
  ])("手动入口没有同提交绿色 CI 时失败关闭：%j", async (...runs) => {
    await expect(
      checkDemoRelease({
        ...input,
        eventName: "workflow_dispatch",
        fetchImpl: github(runs),
      }),
    ).rejects.toThrow("尚无成功的最新 main CI");
  });

  it("旧成功结果不能掩盖较新的失败运行", async () => {
    await expect(
      checkDemoRelease({
        ...input,
        fetchImpl: github([success, { ...success, id: 13, conclusion: "failure" }]),
      }),
    ).rejects.toThrow("尚无成功的最新 main CI");
  });

  it("较新的成功结果允许修复此前失败运行", async () => {
    expect(
      await checkDemoRelease({
        ...input,
        fetchImpl: github([{ ...success, id: 11, conclusion: "failure" }, success]),
      }),
    ).toMatchObject({ shouldDeploy: true });
  });

  it("GitHub API 出错时不输出响应中的敏感正文", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("test-secret-response-body", { status: 403 }));
    await expect(checkDemoRelease({ ...input, fetchImpl })).rejects.toThrow(
      "Demo 发布门禁无法读取 GitHub 状态（HTTP 403）",
    );
  });

  it("GitHub API 超时不会授权发布", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("请求超时"));
    await expect(checkDemoRelease({ ...input, fetchImpl })).rejects.toThrow("请求超时");
  });
});
