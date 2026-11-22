import type { WebhookEventType } from "@hoox/protocol";
import { Alert, Button, Card, Input, Space, Tag } from "antd";
import { useCallback, useId, useState } from "react";
import { integrationApi, type IntegrationApi } from "./integration-api.js";
import { IntegrationSecret, IntegrationTenant, useIntegrationItems } from "./integration-shared.js";

const events: readonly WebhookEventType[] = [
  "run.waiting",
  "run.requires_action",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "artifact.published",
];

export function IntegrationWebhooksPage({
  api = integrationApi,
}: {
  readonly api?: IntegrationApi;
}) {
  return (
    <IntegrationTenant title="Webhook">
      {(tenant) => <WebhookEditor api={api} tenant={tenant} />}
    </IntegrationTenant>
  );
}

function WebhookEditor({ api, tenant }: { readonly api: IntegrationApi; readonly tenant: string }) {
  const load = useCallback(() => api.listWebhooks(tenant), [api, tenant]);
  const formId = useId();
  const state = useIntegrationItems(load);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [selected, setSelected] = useState<WebhookEventType[]>(["run.succeeded", "run.failed"]);
  return (
    <div className="agent-page">
      {state.error && <Alert type="error" title={state.error} />}
      {state.secret && <IntegrationSecret value={state.secret} dismiss={state.dismissSecret} />}
      <Card title="注册 Webhook">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void state.run(
              async () =>
                (await api.createWebhook(tenant, { name, endpointUrl, eventTypes: selected }))
                  .secret,
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
            <label htmlFor={`${formId}-endpoint`}>
              公网 HTTPS 地址
              <Input
                id={`${formId}-endpoint`}
                type="url"
                required
                maxLength={2048}
                value={endpointUrl}
                onChange={(event) => setEndpointUrl(event.target.value)}
              />
            </label>
          </Space>
          <fieldset>
            <legend>事件订阅</legend>
            {events.map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={selected.includes(type)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, type]
                        : current.filter((value) => value !== type),
                    )
                  }
                />
                {type}
              </label>
            ))}
          </fieldset>
          <Button
            type="primary"
            htmlType="submit"
            disabled={state.busy || !name.trim() || !endpointUrl || !selected.length}
          >
            注册 Webhook
          </Button>
        </form>
      </Card>
      <Card
        title="Webhook 列表"
        extra={
          <Button disabled={state.busy} onClick={() => void state.refresh()}>
            刷新列表
          </Button>
        }
      >
        <p>停用不可恢复，需要删除后重新注册。密钥仅在注册和轮换时展示一次。</p>
        {!state.items.length && <p>{state.busy ? "正在读取…" : "暂无 Webhook。"}</p>}
        <ul className="agent-row-list">
          {state.items.map((webhook) => (
            <li className="agent-row" key={webhook.id}>
              <div className="agent-row-identity">
                <strong>{webhook.name}</strong>
                <span>{webhook.endpointUrl}</span>
                <span>{webhook.eventTypes.join("、")}</span>
                <span>创建：{webhook.createdAt}</span>
                {webhook.disabledAt && <span>停用时间：{webhook.disabledAt}</span>}
              </div>
              {webhook.disabledReason && <Tag>停用原因：{webhook.disabledReason}</Tag>}
              <Space>
                <Button
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(async () => (await api.rotateWebhook(tenant, webhook.id)).secret)
                  }
                >
                  轮换密钥
                </Button>
                {!webhook.disabledAt && (
                  <Button
                    danger
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(async () => {
                        await api.disableWebhook(tenant, webhook.id);
                        return undefined;
                      })
                    }
                  >
                    停用
                  </Button>
                )}
                <Button
                  danger
                  disabled={state.busy}
                  onClick={() =>
                    void state.run(async () => {
                      await api.removeWebhook(tenant, webhook.id);
                      return undefined;
                    })
                  }
                >
                  删除
                </Button>
              </Space>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
