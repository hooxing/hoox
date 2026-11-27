import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useId, useState } from "react";
import type {
  AdminAccessTokenApiContract,
  AdminAccessTokenDto,
  AdminAccessTokenStatus,
} from "./control-api.js";

function date(value: string | null): string {
  if (value === null) return "从未使用";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "—" : parsed.toLocaleString("zh-CN", { hour12: false });
}

export function AdminAccessTokensPage({ api }: { readonly api: AdminAccessTokenApiContract }) {
  const formId = useId();
  const [tokens, setTokens] = useState<readonly AdminAccessTokenDto[]>([]);
  const [status, setStatus] = useState<AdminAccessTokenStatus>("active");
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [expiryDays, setExpiryDays] = useState("90");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(
    async (filter: AdminAccessTokenStatus, cursor: string | null) => {
      try {
        const page = await api.listAccessTokens({
          status: filter,
          ...(cursor === null ? {} : { cursor }),
        });
        setTokens(page.items);
        setNextCursor(page.nextCursor);
      } catch {
        setError("无法读取后台访问令牌。");
      }
    },
    [api],
  );

  useEffect(() => {
    void reload(status, cursors[pageIndex] ?? null);
  }, [cursors, pageIndex, reload, status]);

  useEffect(() => {
    const expirations = tokens
      .filter((token) => token.revokedAt === null)
      .map((token) => Date.parse(token.expiresAt))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now);
    if (expirations.length === 0) return;
    const nextExpiration = Math.min(...expirations);
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, Math.min(nextExpiration - now, 60_000)),
    );
    return () => clearTimeout(timer);
  }, [now, tokens]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || (!read && !write)) return;
    setBusy(true);
    setError("");
    try {
      const scopes = [
        ...(read || write ? (["agent-config:read"] as const) : []),
        ...(write ? (["agent-config:write"] as const) : []),
      ];
      const result = await api.createAccessToken({
        name: name.trim(),
        scopes,
        expiresAt: new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString(),
      });
      setOneTimeToken(result.token);
      setName("");
      setStatus("active");
      setCursors([null]);
      setPageIndex(0);
      await reload("active", null);
    } catch {
      setError("令牌创建失败，请检查名称和权限后重试。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: AdminAccessTokenDto) => {
    if (busy || token.revokedAt !== null || !window.confirm(`撤销“${token.name}”？`)) return;
    setBusy(true);
    setError("");
    try {
      await api.revokeAccessToken(token.id);
      await reload(status, cursors[pageIndex] ?? null);
    } catch {
      setError("令牌撤销失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  };

  const selectStatus = (nextStatus: AdminAccessTokenStatus) => {
    setStatus(nextStatus);
    setCursors([null]);
    setPageIndex(0);
  };

  const nextPage = () => {
    if (nextCursor === null) return;
    setCursors((current) => [...current.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((current) => current + 1);
  };

  return (
    <section className="agent-page access-token-page" aria-label="后台访问令牌">
      <Card title="创建令牌">
        <Typography.Paragraph>
          令牌供 CLI 和 CI 管理 Agent 配置，以创建者身份执行，并在每次请求时检查当前后台权限。详见{" "}
          <a
            href="https://github.com/hooxing/hoox/blob/main/docs/reference/cli.md"
            target="_blank"
            rel="noreferrer"
          >
            CLI 参考
          </a>
          。
        </Typography.Paragraph>
        <form className="agent-fields" onSubmit={(event) => void create(event)}>
          <div className="credential-form-fields">
            <label className="agent-field" htmlFor={`${formId}-name`}>
              名称
              <Input
                id={`${formId}-name`}
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="agent-field" htmlFor={`${formId}-expiry`}>
              有效期
              <Select
                id={`${formId}-expiry`}
                value={expiryDays}
                onChange={setExpiryDays}
                options={[
                  { value: "7", label: "7 天" },
                  { value: "30", label: "30 天" },
                  { value: "60", label: "60 天" },
                  { value: "90", label: "90 天（默认）" },
                ]}
              />
            </label>
          </div>
          <fieldset className="credential-scopes">
            <legend>作用域</legend>
            <div className="credential-scope-options">
              <Checkbox
                checked={read || write}
                disabled={write}
                onChange={(event) => setRead(event.target.checked)}
              >
                Agent 配置读取
              </Checkbox>
              <Checkbox checked={write} onChange={(event) => setWrite(event.target.checked)}>
                Agent 配置写入（包含读取）
              </Checkbox>
            </div>
          </fieldset>
          <Button
            className="credential-submit"
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={!name.trim() || (!read && !write)}
          >
            创建令牌
          </Button>
        </form>
      </Card>
      {error && <Alert type="error" showIcon title={error} />}
      {oneTimeToken && (
        <Modal
          open
          title="请立即复制令牌"
          onCancel={() => setOneTimeToken("")}
          footer={
            <Button type="primary" onClick={() => setOneTimeToken("")}>
              我已保存，关闭
            </Button>
          }
        >
          <p>明文只显示这一次。关闭后无法再次查看。</p>
          <Typography.Paragraph style={{ overflowWrap: "anywhere" }}>
            <code>{oneTimeToken}</code>
          </Typography.Paragraph>
        </Modal>
      )}
      <Card title="令牌列表">
        <Space orientation="vertical" style={{ display: "flex", minWidth: 0 }}>
          <Select<AdminAccessTokenStatus>
            aria-label="令牌状态筛选"
            value={status}
            onChange={selectStatus}
            options={[
              { value: "active", label: "有效" },
              { value: "expired", label: "已过期" },
              { value: "revoked", label: "已撤销" },
            ]}
          />
          <Table
            rowKey="id"
            dataSource={tokens}
            pagination={false}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: "没有符合条件的令牌。" }}
            columns={[
              { title: "名称", dataIndex: "name" },
              { title: "作用域", render: (_, token) => token.scopes.join("、") },
              { title: "创建者", dataIndex: "createdBy" },
              { title: "创建时间", render: (_, token) => date(token.createdAt) },
              { title: "最后使用", render: (_, token) => date(token.lastUsedAt) },
              { title: "过期时间", render: (_, token) => date(token.expiresAt) },
              {
                title: "状态",
                render: (_, token) =>
                  token.revokedAt !== null ? (
                    <Tag>已撤销</Tag>
                  ) : Date.parse(token.expiresAt) <= now ? (
                    <Tag color="warning">已过期</Tag>
                  ) : (
                    <Tag color="success">有效</Tag>
                  ),
              },
              {
                title: "操作",
                render: (_, token) => (
                  <Button
                    type="link"
                    danger
                    disabled={
                      busy || token.revokedAt !== null || Date.parse(token.expiresAt) <= now
                    }
                    onClick={() => void revoke(token)}
                  >
                    撤销
                  </Button>
                ),
              },
            ]}
          />
          <nav aria-label="令牌分页">
            <Space wrap>
              <Button
                disabled={busy || pageIndex === 0}
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              >
                上一页
              </Button>
              <Typography.Text>第 {pageIndex + 1} 页</Typography.Text>
              <Button disabled={busy || nextCursor === null} onClick={nextPage}>
                下一页
              </Button>
            </Space>
          </nav>
        </Space>
      </Card>
    </section>
  );
}
