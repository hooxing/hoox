import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const team = {
  id: "tenant_fixture_team",
  displayName: "示例团队",
  role: "owner",
  joinedAt: "2026-11-27T00:00:00.000Z",
};
const date = "2026-11-27T00:00:00.000Z";
const runningThread = {
  id: "thread_running",
  title: "生成交付文件",
  status: "active",
  createdAt: date,
  updatedAt: date,
};
const cleanThread = { ...runningThread, id: "thread_clean", title: "另一条会话" };
const teamThread = {
  ...runningThread,
  id: "thread_team_new",
  title: "团队会话",
  tenantId: team.id,
};
const teamRun = {
  id: "run_team_new",
  threadId: teamThread.id,
  status: "succeeded",
  createdAt: date,
  updatedAt: date,
};
const running = {
  id: "run_running",
  threadId: runningThread.id,
  status: "running",
  createdAt: date,
  updatedAt: date,
};
const started = {
  eventId: "event_deliver",
  sequence: 0,
  occurredAt: date,
  kind: "agent_event",
  type: "tool.started",
  payload: {
    name: "write_file",
    callId: "file",
    presentation: { action: "write", title: "hello.md" },
  },
};

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.HOOX_WORKSPACE_SCREENSHOTS !== "1") return;
  const out = resolve("temp/screenshots/workspace-polish");
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: resolve(out, `${name}.png`), animations: "disabled" });
}

async function mockWorkspace(page: Page) {
  const requests: { path: string; tenant?: string }[] = [];
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      "hoox.auth-session.v2",
      JSON.stringify({
        accessToken: "workspace-mock-token",
        expiresAt: "2099-12-31T23:59:59.000Z",
        profile: { id: "user_fixture", displayName: "测试用户", email: "tester@example.invalid" },
      }),
    );
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const tenant = request.headers()["x-tenant-id"];
    requests.push({
      path: `${request.method()} ${pathname}`,
      ...(tenant === undefined ? {} : { tenant }),
    });
    const data = (value: unknown) => route.fulfill({ json: { data: value } });
    switch (`${request.method()} ${pathname}`) {
      case "GET /api/v1/installation":
        return data({ initialized: true });
      case "GET /api/v1/public/branding":
        return data({});
      case "GET /api/v1/me/teams":
        return data({ items: [team] });
      case "GET /api/v1/agents":
        return data({
          items: [
            {
              id: "agent_default",
              displayName: "Hoox 默认助手",
              description: "",
              suggestedQuestions: [],
            },
          ],
        });
      case "GET /api/v1/me/history-files":
        return data({ items: [], range: {}, hasOlder: false });
      case "GET /api/v1/threads":
        return data({ items: tenant === team.id ? [] : [runningThread, cleanThread] });
      case "POST /api/v1/threads":
        return data(teamThread);
      case "POST /api/v1/threads/thread_team_new/inputs":
        return data({
          receiptId: "receipt_team",
          inputSequence: 1,
          requestedMode: "auto",
          disposition: "queued",
          queuedRun: teamRun,
        });
      case "GET /api/v1/threads/thread_team_new":
        return data(teamThread);
      case "GET /api/v1/threads/thread_running":
        return data(runningThread);
      case "GET /api/v1/threads/thread_running/runs":
        return data({ items: [running] });
      case "GET /api/v1/threads/thread_team_new/runs/run_team_new":
        return data(teamRun);
      case "GET /api/v1/threads/thread_running/runs/run_running":
        return data(running);
      case "GET /api/v1/threads/thread_team_new/context":
      case "GET /api/v1/threads/thread_clean/context":
      case "GET /api/v1/threads/thread_running/context":
        return data({ items: [], hasMore: false });
      case "GET /api/v1/threads/thread_team_new/continuity":
      case "GET /api/v1/threads/thread_clean/continuity":
      case "GET /api/v1/threads/thread_running/continuity":
        return data({ queueDepth: 0, contextSequence: 0, compactionWindow: 0 });
      case "GET /api/v1/threads/thread_team_new/runs/run_team_new/artifacts":
      case "GET /api/v1/threads/thread_running/runs/run_running/artifacts":
        return data({ items: [] });
      case "GET /api/v1/threads/thread_running/runs/run_running/events/stream":
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: run-events\ndata: ${JSON.stringify({ run: running, page: { attemptId: "attempt_running", items: [started], hasMore: false } })}\n\nevent: end\ndata: {"reason":"settled"}\n\n`,
        });
      case "GET /api/v1/threads/thread_team_new/runs/run_team_new/events/stream":
        return route.fulfill({
          contentType: "text/event-stream",
          body: 'event: end\ndata: {"reason":"settled"}\n\n',
        });
      case "GET /api/v1/threads/thread_team_new/runs":
        return data({ items: [teamRun] });
      case "GET /api/v1/threads/thread_clean/runs":
        return data({ items: [] });
      default:
        unexpected.push(`${request.method()} ${pathname}`);
        return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_MOCK_REQUEST" } } });
    }
  });
  await page.goto("/app");
  return { requests, unexpected };
}

test("云盘最近文件提供原对话回找指引", async ({ page }) => {
  const { unexpected } = await mockWorkspace(page);
  await page.getByRole("button", { name: "云盘", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "云盘" });
  await expect(dialog.getByText("最近还没有可用文件")).toBeVisible();
  await expect(dialog.getByText("在云盘找不到交付文件时，可回到原对话预览或下载。")).toBeVisible();
  await capture(page, "01-cloud-drive-guidance");
  expect(unexpected).toEqual([]);
});

test("切换会话清除上一会话的文件活动和快速恢复占位", async ({ page }) => {
  const { unexpected } = await mockWorkspace(page);
  await expect(page.locator(".run-progress-primary").getByText("正在生成文件")).toBeVisible();
  await page.getByRole("button", { name: cleanThread.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: cleanThread.title })).toBeVisible();
  await expect(page.getByText("从一个明确的目标开始")).toBeVisible();
  await expect(page.getByText("正在生成文件")).toHaveCount(0);
  await expect(page.getByText("正在恢复最新运行…")).toHaveCount(0);
  await capture(page, "02-switch-thread-clean");
  expect(unexpected).toEqual([]);
});

test("新会话展示真实空间，选择团队立即切换请求的 Tenant", async ({ page }) => {
  const { requests, unexpected } = await mockWorkspace(page);
  await page.getByRole("button", { name: "新建会话" }).click();
  const destination = page.getByLabel("创建到");
  await expect(destination).toHaveValue("");
  await destination.selectOption(team.id);
  await expect(destination).toHaveValue(team.id);
  await expect
    .poll(() =>
      requests.some(
        (request) => request.path === "GET /api/v1/agents" && request.tenant === team.id,
      ),
    )
    .toBe(true);
  await capture(page, "03-team-destination");
  await page.getByRole("textbox", { name: "发送给 Hoox 的任务" }).fill(teamThread.title);
  await page.getByRole("button", { name: "发送任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: teamThread.title })).toBeVisible();
  expect(requests.filter((request) => request.path.startsWith("POST "))).toEqual([
    { path: "POST /api/v1/threads", tenant: team.id },
    { path: "POST /api/v1/threads/thread_team_new/inputs", tenant: team.id },
  ]);
  expect(unexpected).toEqual([]);
});
