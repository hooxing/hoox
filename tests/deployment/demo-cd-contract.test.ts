import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Demo 持续部署契约", () => {
  it("只在 main 的绿色 CI 后自动发布，并始终使用固定 commit 的 Action 与镜像 digest", () => {
    const workflow = source(".github/workflows/cd-demo.yml");
    expect(workflow).toContain('workflows: ["持续集成"]');
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("HOOX_DEMO_IMAGE='$IMAGE_NAME@$IMAGE_DIGEST'");
    const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => /@[0-9a-f]{40}$/u.test(action ?? ""))).toBe(true);
  });

  it("Demo 镜像只构建实际运行服务，不被未部署的后台 Web 阻塞", () => {
    const dockerfile = source("Dockerfile.demo");
    expect(dockerfile).toContain('--filter "@hoox/api..."');
    expect(dockerfile).toContain('--filter "@hoox/agent-worker..."');
    expect(dockerfile).toContain('--filter "@hoox/scheduler..."');
    expect(dockerfile).toContain('--filter "@hoox/web..."');
    expect(dockerfile).not.toContain("&& pnpm build");
    expect(dockerfile).toContain("pnpm install --offline --prod --frozen-lockfile --force");
    expect(dockerfile).toContain("org.opencontainers.image.source");
    expect(dockerfile).toContain("CI=true");
  });

  it("数据库和对象存储只绑定回环，应用容器采用只读非特权运行边界", () => {
    const compose = source("deploy/demo/docker-compose.yml");
    expect(compose).toContain('"127.0.0.1:15432:5432"');
    expect(compose).toContain('"127.0.0.1:19000:9000"');
    expect(compose).toContain('"127.0.0.1:19001:9001"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain(`cap_drop:
    - ALL`);
    expect(compose).not.toContain("privileged: true");
    expect(source("deploy/demo/postgres-init.sh")).toContain("LOGIN NOINHERIT PASSWORD");
    expect(compose).toContain('mc admin user add runtime "$${S3_ACCESS_KEY_ID}"');
    expect(compose).toContain("mc admin policy attach runtime readwrite");
  });

  it("发布失败只回滚应用镜像，不自动执行数据库 down", () => {
    const deploy = source("deploy/demo/remote-deploy.sh");
    expect(deploy).toContain("rollback()");
    expect(deploy).toContain("数据库迁移不会自动回退");
    expect(deploy).toContain("/api/api/auth/sign-in/email");
    expect(deploy).toContain("/api/v1/auth/exchange");
    expect(deploy).toContain("nginx_bootstrap_configuration");
    expect(deploy).toContain("| compose exec -T postgres psql");
    expect(deploy).toContain("sudo rm -f /etc/nginx/conf.d/hoox-demo-bootstrap.conf");
    expect(deploy).not.toContain("db:migrate:down");
    expect(deploy).not.toContain('["node", "runtime-ts/packages/persistence/dist/cli.js", "down"]');
  });

  it("同一 HTTPS 域名只通过明确路径转发 API 和 Demo 对象桶", () => {
    const nginx = source("deploy/demo/nginx.conf.template");
    const apiExample = source("deploy/demo/api.env.example");
    expect(nginx).toContain("location /api/");
    expect(nginx).toContain("location ^~ /@@BUCKET@@/");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3001/");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:19000");
    expect(apiExample).toContain("DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc");
    expect(apiExample).toContain("DEV_AUTH_ENABLED=false");
  });
});
