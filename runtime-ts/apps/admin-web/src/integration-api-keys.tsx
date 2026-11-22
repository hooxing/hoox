import type { CreateApiKeyRequest } from "@hoox/protocol";
import { Alert, Button, Card, Input, Space, Tag } from "antd";
import { useCallback, useId, useState } from "react";
import { integrationApi, type IntegrationApi } from "./integration-api.js";
import { IntegrationSecret, IntegrationTenant, useIntegrationItems } from "./integration-shared.js";

const scopes: readonly CreateApiKeyRequest["scopes"][number][] = [
  "threads:read",
  "threads:create",
  "runs:read",
  "runs:create",
  "tool-results:submit",
];

export function IntegrationApiKeysPage({
  api = integrationApi,
}: {
  readonly api?: IntegrationApi;
}) {
  return (
    <IntegrationTenant title="API Key">
      {(tenant) => <KeyEditor api={api} tenant={tenant} />}
    </IntegrationTenant>
  );
}

function KeyEditor({ api, tenant }: { readonly api: IntegrationApi; readonly tenant: string }) {
  const load = useCallback(() => api.listKeys(tenant), [api, tenant]);
  const formId = useId();
  const state = useIntegrationItems(load);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selected, setSelected] = useState<CreateApiKeyRequest["scopes"]>([
    "threads:read",
    "runs:read",
  ]);
  return (
    <div className="agent-page">
      {state.error && <Alert type="error" title={state.error} />}
      {state.secret && <IntegrationSecret value={state.secret} dismiss={state.dismissSecret} />}
      <Card title="创建 API Key">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void state.run(
              async () =>
                (
                  await api.createKey(tenant, {
                    name,
                    ...(note.trim() ? { note: note.trim() } : {}),
                    scopes: selected,
                    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
                  })
                ).token,
            );
          }}
        >
          <Space wrap>
            <label htmlFor={`${formId}-name`}>
              名称
              <Input
                id={`${formId}-name`}
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label htmlFor={`${formId}-note`}>
              备注
              <Input
                id={`${formId}-note`}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <label>
              到期时间
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
          </Space>
          <fieldset>
            <legend>作用域</legend>
            {scopes.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((value) => value !== scope),
                    )
                  }
                />
                {scope}
              </label>
            ))}
          </fieldset>
          <Button
            type="primary"
            htmlType="submit"
            disabled={state.busy || !name.trim() || !selected.length}
          >
            创建 API Key
          </Button>
        </form>
      </Card>
      <Card
        title="API Key 列表"
        extra={
          <Button disabled={state.busy} onClick={() => void state.refresh()}>
            刷新列表
          </Button>
        }
      >
        <p>
          轮换立即使旧 Key 失效，保留集成身份、作用域与到期时间；吊销同时撤销集成身份的 Membership。
        </p>
        {!state.items.length && <p>{state.busy ? "正在读取…" : "暂无 API Key。"}</p>}
        <ul className="agent-row-list">
          {state.items.map((key) => (
            <li className="agent-row" key={key.id}>
              <div className="agent-row-identity">
                <strong>{key.name}</strong>
                <code>{key.prefix}…</code>
                <span>{key.note}</span>
                <span>{key.scopes.join("、")}</span>
                <span>
                  创建：{key.createdAt} · 到期：{key.expiresAt ?? "永不过期"} · 最近使用：
                  {key.lastUsedAt ?? "尚未使用"}
                </span>
              </div>
              {key.revokedAt ? (
                <Tag>已吊销：{key.revokedAt}</Tag>
              ) : (
                <Space>
                  <Button
                    disabled={
                      state.busy ||
                      (key.expiresAt !== undefined && Date.parse(key.expiresAt) <= Date.now())
                    }
                    onClick={() =>
                      void state.run(async () => (await api.rotateKey(tenant, key.id)).token)
                    }
                  >
                    轮换
                  </Button>
                  <Button
                    danger
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(async () => {
                        await api.revokeKey(tenant, key.id);
                        return undefined;
                      })
                    }
                  >
                    吊销
                  </Button>
                </Space>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
