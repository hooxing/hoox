import { Alert, Button, Card, Input, Space, Typography } from "antd";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AdminApiError } from "./api.js";

export function IntegrationTenant({
  title,
  children,
}: {
  readonly title: string;
  readonly children: (tenant: string) => ReactNode;
}) {
  const [input, setInput] = useState("");
  const tenantInputId = useId();
  const [tenant, setTenant] = useState("");
  return (
    <div className="agent-page">
      <Typography.Title level={2}>{title}</Typography.Title>
      <Card title="目标 Tenant">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTenant(input.trim());
          }}
        >
          <Space wrap>
            <label htmlFor={tenantInputId}>
              Tenant ID
              <Input
                id={tenantInputId}
                required
                maxLength={128}
                pattern="[A-Za-z0-9_-]{3,128}"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
            <Button htmlType="submit" disabled={!input.trim()}>
              选择 Tenant
            </Button>
          </Space>
        </form>
        <Typography.Paragraph type="secondary">
          按 Tenant ID 选择部署的主 Tenant、个人空间或团队空间；此处仅限平台管理员。
        </Typography.Paragraph>
      </Card>
      {tenant && (
        <section key={tenant} aria-label={`Tenant ${tenant}`}>
          <Typography.Paragraph>
            当前 Tenant：<code>{tenant}</code>
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
      <Typography.Paragraph>
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
