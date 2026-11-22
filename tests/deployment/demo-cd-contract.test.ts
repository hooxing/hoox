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
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).not.toContain("inputs.ref");
    expect(workflow).toContain("HOOX_DEMO_IMAGE='$IMAGE_NAME@$IMAGE_DIGEST'");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).not.toContain("docker/setup-qemu-action");
    expect(workflow.match(/secrets\.DEMO_GHCR_TOKEN/gu)).toHaveLength(2);
    expect(workflow).not.toContain("secrets.GITHUB_TOKEN");
    expect(workflow).toContain('"https://$HOOX_DEMO_DOMAIN/admin/runs"');
    const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => /@[0-9a-f]{40}$/u.test(action ?? ""))).toBe(true);
  });

  it("在构建与远端操作前分别拒绝过期发布，并在失败后清理独立凭据", () => {
    const workflow = source(".github/workflows/cd-demo.yml");
    expect(workflow.match(/run: node scripts\/demo-release-gate\.mjs/gu)).toHaveLength(2);
    expect(workflow).toContain("actions: read");
    expect(workflow).not.toContain("packages: write");
    expect(workflow).toContain("persist-credentials: false");
    for (const name of ["初始化 Buildx", "登录 GHCR", "构建并推送 Demo 镜像"]) {
      expect(workflow).toContain(
        `name: ${name}\n        if: steps.revision.outputs.should_deploy == 'true'`,
      );
    }
    for (const name of ["上传部署契约", "发布并验证"]) {
      expect(workflow).toContain(
        `name: ${name}\n        if: steps.preflight.outputs.should_deploy == 'true'`,
      );
    }
    expect(workflow).toMatch(
      /name: 配置 SSH\s+id: ssh\s+if: steps.preflight.outputs.should_deploy == 'true'/u,
    );
    expect(workflow).toContain("if: always() && steps.ssh.outcome == 'success'");
    expect(workflow).toContain("DOCKER_CONFIG='$REMOTE_DOCKER_CONFIG' docker login");
    expect(workflow).toContain("DOCKER_CONFIG='$REMOTE_DOCKER_CONFIG' HOOX_DEMO_ROOT");
    expect(workflow).toContain('{"auths":{"ghcr.io":{}}}');
    expect(workflow).toContain('DOCKER_CONFIG="$config_dir" docker logout ghcr.io');
    expect(workflow).toContain('rm -f "$config_dir/config.json"');
    expect(workflow).toContain("trap 'rm -f \"$HOME/.ssh/hoox-demo\"' EXIT");
    expect(workflow).toContain("ConnectTimeout 15");
    expect(workflow).toContain("ServerAliveCountMax 3");
    expect(
      workflow.match(/--connect-timeout 10 --max-time 20 --retry-max-time 120/gu),
    ).toHaveLength(3);
  });

  it("Demo 镜像构建用户端、后台端及其统一 API", () => {
    const dockerfile = source("Dockerfile.demo");
    expect(dockerfile).toContain('--filter "@hoox/api..."');
    expect(dockerfile).toContain('--filter "@hoox/agent-worker..."');
    expect(dockerfile).toContain('--filter "@hoox/scheduler..."');
    expect(dockerfile).toContain('--filter "@hoox/web..."');
    expect(dockerfile).toContain('--filter "@hoox/admin-control-api..."');
    expect(dockerfile).not.toContain("trajectory-web");
    expect(dockerfile).toContain("RUN mkdir -p model-wire-traces");
    expect(dockerfile).toContain("pnpm --filter @hoox/admin-web build:demo");
    expect(dockerfile).not.toContain("&& pnpm build");
    expect(dockerfile).toContain("pnpm install --offline --prod --frozen-lockfile --force");
    expect(dockerfile).toContain("org.opencontainers.image.source");
    expect(dockerfile).toContain("CI=true");
    expect(dockerfile).toContain("COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./");
    expect(dockerfile).toContain("COPY third_party/pi ./licenses/third-party/pi");
    expect(dockerfile).toContain("COPY scripts/prepare-demo-sandbox-key.mjs");
    expect(dockerfile).not.toContain("anthropic-skills-pptx");
  });

  it("CD 所依赖的主 CI 同步 pnpm hook，并完整预置 Admin Control 数据库角色", () => {
    expect(source("Dockerfile.demo")).toContain(".pnpmfile.cjs ./");

    const ci = source(".github/workflows/ci.yml");
    expect(ci).toMatch(
      /engineering-checks:\s+name: 工程构建与测试\s+runs-on: ubuntu-latest\s+timeout-minutes: 2[0-9]/u,
    );
    expect(ci.match(/DATABASE_ADMIN_CONTROL_ROLE: m4_ci_admin_control/gu)).toHaveLength(2);
    expect(ci).toContain(
      "M4_DATABASE_ADMIN_CONTROL_PASSWORD: ci-admin-control-placeholder-password",
    );
    expect(ci).toContain("pnpm security:audit:production");

    const prepare = source("runtime-ts/packages/persistence/scripts/prepare-m4-ci-database.ts");
    expect(prepare).toContain('identifier("DATABASE_ADMIN_CONTROL_ROLE")');
    expect(prepare).toContain('required("M4_DATABASE_ADMIN_CONTROL_PASSWORD")');
    expect(prepare).toContain("AS admin_control_safe");
  });

  it("数据库和对象存储只绑定回环，Demo 不再运行独立轨迹容器", () => {
    const compose = source("deploy/demo/docker-compose.yml");
    expect(compose).toContain('"127.0.0.1:15432:5432"');
    expect(compose).toContain('"127.0.0.1:19000:9000"');
    expect(compose).toContain('"127.0.0.1:19001:9001"');
    expect(compose).toContain("admin-control:");
    expect(compose).toContain("admin-web:");
    expect(compose).not.toContain("trajectory:");
    expect(compose).toContain("shared/admin-control.env");
    expect(compose).toContain("DEMO_ADMIN_USER_ID: ${DEMO_ADMIN_USER_ID");
    expect(compose).toContain("DEV_ADMIN_CONTROL_USER_ID: ${DEMO_ADMIN_USER_ID");
    expect(compose).toContain("runtime-ts/apps/admin-web/dist");
    expect(compose).toContain('MODEL_WIRE_TRACE_ENABLED: "true"');
    expect(compose).toContain("trajectory_data:/opt/hoox/model-wire-traces");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toMatch(/cap_drop:\s*\n\s+- ALL/u);
    expect(compose).not.toContain("privileged: true");
    expect(source("deploy/demo/postgres-init.sh")).toContain("LOGIN NOINHERIT PASSWORD");
    expect(compose).toContain('mc admin user add runtime "$${S3_ACCESS_KEY_ID}"');
    expect(compose).toContain('mc admin user add runtime "$${SKILL_PUBLISHER_S3_ACCESS_KEY_ID}"');
    expect(compose).toContain("mc admin policy attach runtime readwrite");
    expect(compose).toContain("name: hoox-demo-postgres-data-20261120");
    expect(compose).toContain("name: hoox-demo-minio-data-20261120");
    expect(compose).toContain("name: hoox-demo-trajectory-data-20260903");
    expect(compose).not.toContain("name: hoox-demo-trajectory-${HOOX_DEMO_RELEASE_ID");
    expect(compose).not.toMatch(/^\s*name: hoox-demo-(?:postgres|minio)-data\s*$/gmu);
  });

  it("发布初始化后台管理员，失败时回滚应用与基础服务且兼容旧发布", () => {
    const deploy = source("deploy/demo/remote-deploy.sh");
    expect(deploy).toContain("admin-control.env");
    expect(deploy).toContain("node scripts/prepare-demo-sandbox-key.mjs");
    expect(deploy).toContain("--network none");
    expect(deploy.indexOf("prepare-demo-sandbox-key.mjs")).toBeLessThan(
      deploy.indexOf("compose --profile ops run --rm migrate"),
    );
    expect(deploy).toContain("DEMO_ADMIN_USER_ID");
    expect(deploy).toContain("platform_control_operators");
    expect(deploy).toContain("platform_skill_operators");
    expect(deploy).toContain("restore_services=(postgres minio api web scheduler worker)");
    expect(deploy).toContain('up -d --force-recreate "' + "$" + '{restore_services[@]}"');
    expect(deploy).toContain("restore_services+=(admin-control admin-web)");
    expect(deploy).toContain("for service in api web admin-control admin-web scheduler worker");
    expect(deploy).toContain("rollback()");
    expect(deploy).toContain("数据库迁移不会自动回退");
    expect(deploy).toContain("/api/api/auth/sign-in/email");
    expect(deploy).toContain("better_auth_users SET email_verified=true");
    expect(deploy).toContain("email_verified=true");
    expect(deploy).toContain('demo_identity_verified" != "true"');
    expect(deploy.indexOf("email_verified=true")).toBeLessThan(
      deploy.indexOf("/api/api/auth/sign-in/email"),
    );
    expect(deploy).toContain("/api/v1/auth/exchange");
    expect(deploy).toContain("nginx_bootstrap_configuration");
    expect(deploy).toContain("/etc/nginx/hoox-demo-admin-token.conf");
    expect(deploy).toContain("-o root -g root -m 0600");
    expect(deploy).toContain("https://$domain/v1/admin/control/overview");
    expect(deploy).toContain("admin_access_token");
    expect(deploy).toContain("--force-recreate api admin-control admin-web scheduler worker");
    expect(deploy).toContain("compose up -d --force-recreate postgres minio");
    expect(deploy).toContain("HOOX_DEMO_RELEASE_ID");
    expect(deploy).not.toContain("/trajectory/api/");
    expect(deploy).not.toContain('docker volume rm "hoox-demo-trajectory-$old_release_id"');
    expect(deploy).not.toContain('docker volume rm "hoox-demo-trajectory-data-20260903"');
    expect(deploy).not.toContain("admin_netrc");
    expect(deploy).not.toContain("openssl passwd");
    expect(deploy).toContain("| compose exec -T postgres psql");
    expect(deploy).toContain("sudo rm -f /etc/nginx/conf.d/hoox-demo-bootstrap.conf");
    expect(deploy).not.toContain("db:migrate:down");
    expect(deploy).not.toContain('["node", "runtime-ts/packages/persistence/dist/cli.js", "down"]');
  });

  it("同一 HTTPS 域名明确隔离用户 API、后台入口和 Demo 对象桶", () => {
    const nginx = source("deploy/demo/nginx.conf.template");
    const apiExample = source("deploy/demo/api.env.example");
    const adminExample = source("deploy/demo/admin-control.env.example");
    expect(nginx).toContain("location /api/");
    expect(nginx).toContain("location ^~ /@@BUCKET@@/");
    expect(nginx).toContain("location ^~ /admin/");
    expect(nginx).toContain("location ^~ /v1/admin/");
    expect(nginx).toContain("location = /trajectory");
    expect(nginx).toContain("return 308 /admin/runs;");
    expect(nginx).toContain("location ^~ /trajectory/");
    expect(nginx).not.toContain("auth_basic");
    expect(nginx).toContain("location = /_hoox_demo_admin_access");
    expect(nginx).toContain("auth_request /_hoox_demo_admin_access");
    expect(nginx).toContain("proxy_set_header Authorization $http_authorization");
    expect(nginx).toContain("include /etc/nginx/hoox-demo-admin-token.conf");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3001/");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3003");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:4174/");
    expect(nginx).not.toContain("127.0.0.1:4188");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:19000");
    expect(nginx).not.toContain("DEV_ADMIN_CONTROL_TOKEN");
    expect(apiExample).toContain("DEMO_PUBLIC_ORIGIN=https://hoox.aisay.cc");
    expect(apiExample).toContain("DEMO_ADMIN_USER_ID=user_demo_pending");
    expect(apiExample).toContain("DEV_AUTH_ENABLED=false");
    expect(adminExample).toContain("ADMIN_CONTROL_DATABASE_URL=");
    expect(adminExample).toContain("SKILL_PUBLISHER_DATABASE_URL=");
    expect(adminExample).toContain("DEV_ADMIN_CONTROL_TOKEN=");
    expect(source("deploy/demo/infra.env.example")).toContain("SKILL_PUBLISHER_S3_ACCESS_KEY_ID=");
  });
});
