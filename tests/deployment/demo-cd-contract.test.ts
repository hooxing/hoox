import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Demo 持续部署契约", () => {
  it("pipefail 下不把命令输出直接管道给 grep -q，避免 SIGPIPE 使判断随机失败", () => {
    const script = source("deploy/demo/remote-deploy.sh");
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toMatch(/\|\s*grep\s+-[a-zA-Z]*q/u);
  });

  it("Nginx 模板渲染前校验域名与桶名，并拒绝保留路由桶名", () => {
    const script = source("deploy/demo/remote-deploy.sh");
    const domainValidation = script.indexOf('[[ ! "$domain" =~');
    const bucketValidation = script.indexOf('[[ ! "$bucket" =~');
    const reservedValidation = script.indexOf("api|admin|trajectory");
    const render = script.indexOf('sed -e "s/@@DOMAIN@@/$domain/g"');
    expect(domainValidation).toBeGreaterThan(0);
    expect(bucketValidation).toBeGreaterThan(domainValidation);
    expect(reservedValidation).toBeGreaterThan(bucketValidation);
    expect(render).toBeGreaterThan(reservedValidation);
    expect(script).toContain('"Demo 域名格式无效"');
    expect(script).toContain('"Demo 对象桶名称格式无效"');
    expect(script).toContain('"Demo 对象桶名称与保留路由冲突"');
  });

  it.each(["scheduler", "admin-control"])(
    "%s 轨迹对象存储必填项完整，且不混用 Skill 发布凭据",
    (service) => {
      const example = source(`deploy/demo/${service}.env.example`);
      for (const key of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_REGION",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_FORCE_PATH_STYLE",
      ]) {
        expect(example, key).toMatch(new RegExp(`^${key}=\\S+$`, "mu"));
      }
      expect(example).toContain("S3_ENDPOINT=http://127.0.0.1:19000");
      expect(example).toContain("S3_BUCKET=agent-runtime-demo");
      expect(example).toContain("S3_FORCE_PATH_STYLE=true");
      for (const key of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
        expect(example).toMatch(new RegExp(`^${key}=replace-`, "mu"));
      }
      if (service === "admin-control") {
        const runtimeKey = example.match(/^S3_ACCESS_KEY_ID=(.*)$/mu)?.[1];
        const publisherKey = example.match(/^SKILL_PUBLISHER_S3_ACCESS_KEY_ID=(.*)$/mu)?.[1];
        expect(runtimeKey).not.toBe(publisherKey);
      }
    },
  );

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

  it("后台关键词不进入 Fastify 或 Demo Nginx 访问日志", () => {
    const api = source("runtime-ts/apps/admin-control-api/src/app.ts");
    const routes = source("runtime-ts/apps/admin-control-api/src/run-explorer-routes.ts");
    const nginx = source("deploy/demo/nginx.conf.template");
    expect(api).toContain('"req.body"');
    expect(routes).toContain('app.post<{ Body: RunListQuery }>(\n    "/v1/admin/control/runs"');
    expect(nginx).not.toContain("$request_body");
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

  it("API 与 Worker 的 Compose 环境强制启用历史文件系统", () => {
    const compose = source("deploy/demo/docker-compose.yml");
    for (const service of ["api", "worker"]) {
      const block = compose.match(
        new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:)`, "m"),
      );
      expect(block, `缺少 ${service} 服务`).not.toBeNull();
      expect(block?.[1]).toMatch(
        /^ {4}environment:\n(?: {6}[^\n]*\n)* {6}HISTORY_FILESYSTEM_ENABLED: "true"$/m,
      );
    }
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
    expect(compose).not.toContain("trajectory_data:/opt/hoox/model-wire-traces");
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
    expect(compose).not.toContain("trajectory_data:");
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
    expect(deploy).toContain(
      "UPDATE :\\\"runtime_schema\\\".installation_state SET administrator_user_id=:'demo_user_id',initialized_at=COALESCE(initialized_at,clock_timestamp()) WHERE singleton=true AND administrator_user_id IS NULL",
    );
    expect(deploy).not.toContain(
      "UPDATE :\\\"runtime_schema\\\".installation_state SET administrator_user_id=:'demo_user_id' WHERE singleton=true;",
    );
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
    expect(deploy).toContain(
      "compose up -d --remove-orphans --force-recreate api admin-control admin-web scheduler worker",
    );
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

  it("CLI 白名单独立校验完整令牌、方法和 URI，畸形字段不能绕过后台会话校验", () => {
    const nginx = source("deploy/demo/nginx.conf.template");
    expect(nginx).toContain("map $http_authorization $hoox_demo_cli_token_format");
    expect(nginx).toContain('"~^Bearer hoox_at_[A-Za-z0-9_-]{43}$" 1;');
    expect(nginx).toContain("map $request_method $hoox_demo_cli_method");
    expect(nginx).toContain("map $request_uri $hoox_demo_cli_uri");
    expect(nginx).toContain(
      'map "$hoox_demo_cli_token_format:$hoox_demo_cli_method:$hoox_demo_cli_uri" $hoox_demo_cli_access',
    );
    expect(nginx).not.toContain('map "$http_authorization:$request_method:$request_uri"');
    const tokenPattern = /^Bearer hoox_at_[A-Za-z0-9_-]+$/u;
    const token = `Bearer hoox_at_${"x".repeat(43)}`;
    const uriKind = (method: string, uri: string) => {
      const getUri =
        /^\/v1\/admin\/control\/agent-definitions\/[A-Za-z0-9][A-Za-z0-9_-]{2,127}\/revisions(?:\/[A-Za-z0-9][A-Za-z0-9_-]{2,127}\/export)?(?:\?.*)?$/u;
      const postUri =
        /^\/v1\/admin\/control\/agent-definitions\/(?:[A-Za-z0-9][A-Za-z0-9_-]{2,127}\/)?import(?:\?.*)?$/u;
      return method === "GET" && getUri.test(uri)
        ? "GET"
        : method === "POST" && postUri.test(uri)
          ? "POST"
          : "";
    };
    const matches = (auth: string, method: string, uri: string) =>
      tokenPattern.test(auth) && uriKind(method, uri) === method;
    const base = "/v1/admin/control/agent-definitions";
    for (const [method, uri] of [
      ["GET", `${base}/agent_example/revisions`],
      ["GET", `${base}/agent_example/revisions/revision_123/export?format=yaml`],
      ["POST", `${base}/import`],
      ["POST", `${base}/agent_example/import`],
    ] as const)
      expect(matches(token, method, uri)).toBe(true);
    for (const auth of [
      "",
      "Bearer hoox_session_placeholder",
      "Bearer hoox_at_abc:GET",
      `${token}, ${token}`,
      `${token} extra`,
    ])
      expect(matches(auth, "GET", `${base}/agent_example/revisions`)).toBe(false);
    for (const [method, uri] of [
      ["GET", "/v1/admin/control/overview"],
      ["POST", `${base}/agent_example/revisions`],
      ["PUT", `${base}/agent_example/revisions?x=1`],
      [
        "GET",
        "/v1/admin/control/overview?x=1:/v1/admin/control/agent-definitions/agent_example/revisions",
      ],
      ["GET", `${base}/agent_example/%2e%2e/revisions`],
    ] as const)
      expect(matches(token, method, uri), `${method} ${uri}`).toBe(false);
    const session = nginx.split("location ^~ /v1/admin/ {")[1]?.split("\n    }")[0];
    expect(session).toContain("error_page 418 = @hoox_demo_cli;");
    expect(session).toContain("if ($hoox_demo_cli_access) { return 418; }");
    expect(session).toContain("auth_request /_hoox_demo_admin_access;");
    const cli = nginx.split("location @hoox_demo_cli {")[1]?.split("\n    }")[0];
    expect(cli).toContain("proxy_set_header Authorization $http_authorization;");
    expect(cli).not.toContain("hoox-demo-admin-token.conf");
  });

  it("安全头继承到全部 HTTPS 路径及错误响应，HTTP 不设置 HSTS", () => {
    const nginx = source("deploy/demo/nginx.conf.template");
    const [redirect, tls] = nginx.split("listen 443 ssl http2;");
    expect(redirect).toContain("server_tokens off;");
    expect(redirect).not.toContain("Strict-Transport-Security");
    const tlsDefaults = tls?.split("    location ", 1)[0];
    expect(tlsDefaults).toContain("server_tokens off;");
    for (const header of [
      'Strict-Transport-Security "max-age=31536000"',
      `Content-Security-Policy "frame-ancestors 'self'"`,
      "X-Frame-Options SAMEORIGIN",
      "Referrer-Policy no-referrer",
      'Permissions-Policy "camera=(), microphone=(), geolocation=()"',
    ]) {
      expect(tlsDefaults).toContain(`add_header ${header} always;`);
    }
    const reportOnly = tlsDefaults?.match(
      /add_header Content-Security-Policy-Report-Only "(.*?)" always;/u,
    )?.[1];
    expect(reportOnly).toContain("script-src 'self'");
    expect(reportOnly).toContain("style-src 'self' 'unsafe-inline'");
    expect(reportOnly).toContain("img-src 'self' data: blob: https:");
    expect(reportOnly).toContain("font-src 'self' data: https:");
    expect(tls?.slice(tlsDefaults?.length)).not.toContain("add_header ");
  });

  it("同一 HTTPS 域名明确隔离用户 API、后台入口和 Demo 对象桶", () => {
    const nginx = source("deploy/demo/nginx.conf.template");
    const apiExample = source("deploy/demo/api.env.example");
    const adminExample = source("deploy/demo/admin-control.env.example");
    expect(nginx).toContain("location /api/");
    expect(nginx).toContain("client_max_body_size 17m;");
    const upload = nginx.split("location = /api/v1/resources/uploads {")[1]?.split("\n    }")[0];
    expect(upload).not.toContain("proxy_request_buffering off;");
    expect(upload).toContain("error_page 413 = @hoox_upload_payload_too_large;");
    expect(nginx).toContain(
      `return 413 '{"version":"v1","requestId":"$request_id","error":{"code":"PAYLOAD_TOO_LARGE","message":"请求体超过允许大小","retryable":false}}';`,
    );
    expect(upload).toContain("proxy_pass http://127.0.0.1:3001/v1/resources/uploads;");
    expect(nginx).toContain("proxy_set_header Host @@DOMAIN@@;");
    expect(nginx).toContain("return 301 https://@@DOMAIN@@$request_uri;");
    expect(nginx).toContain("location = /admin {\n        return 308 https://@@DOMAIN@@/admin/;");
    expect(nginx).toContain("return 308 https://@@DOMAIN@@/admin/runs;");
    const bucket = nginx.split("location ^~ /@@BUCKET@@/ {")[1]?.split("\n    }")[0];
    expect(bucket).toContain("proxy_set_header Host $http_host;");
    expect(nginx).toContain("location ^~ /@@BUCKET@@/");
    expect(nginx).toContain("location ^~ /admin/");
    expect(nginx).toContain("location ^~ /v1/admin/");
    expect(nginx).toContain("location = /trajectory");
    expect(nginx).toContain("return 308 https://@@DOMAIN@@/admin/runs;");
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
