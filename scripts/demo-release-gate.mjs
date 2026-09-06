import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function checkDemoRelease({
  eventName,
  event,
  repository,
  ref,
  sha,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !token) {
    throw new Error("Demo 发布缺少仓库身份或 GitHub API 凭据");
  }
  const sameRepository = (candidate) => candidate?.toLowerCase() === repository.toLowerCase();
  const run = event.workflow_run;
  let releaseSha;
  if (eventName === "workflow_run") {
    if (
      run?.event !== "push" ||
      run.head_branch !== "main" ||
      run.conclusion !== "success" ||
      !sameRepository(run.head_repository?.full_name)
    ) {
      throw new Error("Demo 自动发布只接受本仓库 main push 的成功 CI");
    }
    releaseSha = run.head_sha;
  } else if (eventName === "workflow_dispatch" && ref === "refs/heads/main") {
    releaseSha = sha;
  } else {
    throw new Error("Demo 手工发布只允许 main 分支");
  }
  if (!/^[a-f0-9]{40}$/u.test(releaseSha ?? "")) {
    throw new Error("Demo 发布提交不是完整 Git SHA");
  }

  const api = async (path) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Demo 发布门禁无法读取 GitHub 状态（HTTP ${response.status}）`);
    }
    return response.json();
  };
  const main = await api("git/ref/heads/main");
  if (main.object?.sha !== releaseSha) {
    return { shouldDeploy: false, releaseSha, reason: "提交已不再是 main 当前版本，跳过过期发布" };
  }
  const query = new URLSearchParams({
    branch: "main",
    event: "push",
    head_sha: releaseSha,
    per_page: "100",
  });
  const runs = await api(`actions/workflows/ci.yml/runs?${query}`);
  // 不按 success 过滤，避免旧的成功结果掩盖同一提交最新的失败或重跑。
  const latest = runs.workflow_runs
    ?.filter(
      (candidate) =>
        candidate.event === "push" &&
        candidate.head_branch === "main" &&
        candidate.head_sha === releaseSha &&
        sameRepository(candidate.head_repository?.full_name),
    )
    .sort((left, right) => right.id - left.id)[0];
  if (latest?.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("Demo 发布提交尚无成功的最新 main CI，请等待或修复 CI 后重试");
  }
  return { shouldDeploy: true, releaseSha, reason: "main 当前提交及最新 CI 已通过发布门禁" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkDemoRelease({
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_deploy=${result.shouldDeploy}\nrelease_id=${result.releaseSha}\n`,
    );
    console.log(result.reason);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Demo 发布门禁失败");
    process.exitCode = 1;
  }
}
