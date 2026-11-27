import { Alert, Button, Card, Select, Space, Typography } from "antd";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AdminApiError } from "./api.js";
import { integrationApi, type IntegrationApi } from "./integration-api.js";

export function IntegrationTenant({
  title,
  children,
  api = integrationApi,
}: {
  readonly title: string;
  readonly api?: IntegrationApi;
  readonly children: (tenant: string) => ReactNode;
}) {
  const selectId = useId();
  const [tenant, setTenant] = useState("");
  const [tenants, setTenants] = useState<Awaited<ReturnType<IntegrationApi["listTenants"]>>>([]);
  const [tenantError, setTenantError] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .listTenants()
      .then((items) => {
        if (!active) return;
        setTenants(items);
        setTenant(items.find((item) => item.isDefault)?.tenantId ?? "");
        setTenantError(false);
      })
      .catch(() => {
        if (active) setTenantError(true);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const selected = tenants.find((item) => item.tenantId === tenant);
  return (
    <div className="agent-page integration-page">
      <Typography.Title level={2}>{title}</Typography.Title>
      <Card title="选择接入空间">
        {title === "API Key" ? (
          <Typography.Paragraph>
            API Key 供部署方自己的后端或脚本调用 Hoox API。示例：
            <code>
              curl -H 'Authorization: Bearer $HOOX_API_KEY' https://your-hoox.example/v1/agents
            </code>
            。详见{" "}
            <a
              href="https://github.com/hooxing/hoox/blob/main/docs/reference/public-api.md"
              target="_blank"
              rel="noreferrer"
            >
              API 参考
            </a>
            。
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph>
            Webhook 在 Run
            等事件发生时通知你的系统。事件：run.waiting、run.requires_action、run.succeeded、run.failed、run.cancelled、artifact.published。接收端须验证签名，详见{" "}
            <a
              href="https://github.com/hooxing/hoox/blob/main/docs/reference/webhooks.md"
              target="_blank"
              rel="noreferrer"
            >
              Webhook 参考
            </a>
            。
          </Typography.Paragraph>
        )}
        <Typography.Paragraph type="secondary">
          通常使用初始化管理员的个人空间；仅在为特定用户或团队空间单独接入时选择其他空间。
        </Typography.Paragraph>
        {tenantError && (
          <Alert type="error" title="无法读取空间列表，请确认平台管理员身份后重试。" />
        )}
        <div className="agent-field integration-tenant-field">
          <label htmlFor={selectId}>空间</label>
          <Select
            id={selectId}
            aria-label="选择空间"
            showSearch={{ optionFilterProp: "label" }}
            value={tenant || null}
            placeholder="请选择空间"
            options={tenants.map((item) => ({
              value: item.tenantId,
              label: `${item.displayName} (${item.tenantId})${item.isDefault ? "（初始化管理员的个人空间）" : item.kind === "personal" ? "（个人空间）" : "（团队空间）"}`,
            }))}
            onChange={setTenant}
            className="integration-tenant-select"
          />
        </div>
        {!tenantError && !tenant && tenants.length > 0 && (
          <Alert type="info" title="此实例未标记默认接入空间，请选择要管理的空间。" />
        )}
      </Card>
      {tenant && (
        <section key={tenant} aria-label={`Tenant ${tenant}`}>
          <Typography.Paragraph>
            当前空间：{selected?.displayName ?? "未知空间"} <code>{tenant}</code>
          </Typography.Paragraph>
          {children(tenant)}
        </section>
      )}
    </div>
  );
}

export function useIntegrationItems<T>(load: () => Promise<readonly T[]>) {
  const [items, setItems] = useState<readonly T[]>([]);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const active = useRef({ current: false });
  const refresh = useCallback(async () => {
    const scope = active.current;
    setBusy(true);
    setError(undefined);
    try {
      const next = await load();
      if (scope.current) setItems(next);
    } catch {
      if (scope.current) setError("无法刷新列表，请核对 Tenant 和平台管理员身份。");
    } finally {
      if (scope.current) setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    const scope = { current: true };
    active.current = scope;
    void refresh();
    return () => {
      scope.current = false;
    };
  }, [refresh]);
  async function run(action: () => Promise<string | undefined>) {
    const scope = active.current;
    setBusy(true);
    setSecret(undefined);
    setError(undefined);
    try {
      const value = await action();
      if (!scope.current) return;
      setSecret(value);
      await refresh();
    } catch (reason) {
      if (scope.current)
        setError(
          reason instanceof AdminApiError
            ? reason.message
            : "无法确认操作结果，请刷新列表核对，不要重复提交。",
        );
    } finally {
      if (scope.current) setBusy(false);
    }
  }
  return { items, secret, error, busy, refresh, run, dismissSecret: () => setSecret(undefined) };
}

export function IntegrationSecret({
  value,
  dismiss,
}: {
  readonly value: string;
  readonly dismiss: () => void;
}) {
  const [error, setError] = useState(false);
  return (
    <Card title="一次性凭据">
      <p>请立即复制并妥善保存，关闭后无法再次查看。请勿放入日志或公开内容。</p>
      <Typography.Paragraph style={{ overflowWrap: "anywhere" }}>
        <code>{value}</code>
      </Typography.Paragraph>
      <Space>
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
            } catch {
              setError(true);
            }
          }}
        >
          复制凭据
        </Button>
        <Button onClick={dismiss}>已保存，关闭</Button>
      </Space>
      {error && <Alert type="error" title="复制失败，请手动复制。" />}
    </Card>
  );
}
