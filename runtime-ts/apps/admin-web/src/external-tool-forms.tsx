import type { AdminHttpToolPreview, AdminMcpDraftDto, AdminMcpDraftSettings } from "@hoox/protocol";
import { Alert, Button, Card, Input, Space, Typography } from "antd";
import { type FormEvent, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AdminApiError } from "./api.js";
import type { ExternalToolApiContract } from "./control-api.js";

function errorText(error: unknown) {
  if (error instanceof AdminApiError) {
    if (error.status === 400) return "提交内容不符合要求，请检查字段。";
    return error.message;
  }
  return "操作未完成，请刷新后重试。";
}

export function useToolAction() {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return { pending, run, error, setError };
}

const value = (data: FormData, key: string) => String(data.get(key) ?? "");

export function McpSettingsForm({
  draft,
  onSave,
  onCancel,
}: {
  draft?: AdminMcpDraftDto;
  onSave: (settings: AdminMcpDraftSettings) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const action = useToolAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const effect = value(data, "sideEffect");
    void action.run(() =>
      onSave({
        displayName: value(data, "displayName").trim(),
        serverName: value(data, "serverName"),
        endpoint: value(data, "endpoint").trim(),
        timeoutMs: Number(data.get("timeoutMs")),
        maxResponseBytes: Number(data.get("maxResponseBytes")),
        sideEffect: effect === "read_only" || effect === "destructive" ? effect : "write",
        idempotent: data.has("idempotent"),
      }),
    );
  }
  return (
    <Card title={draft ? "编辑 MCP 草稿" : "新建 MCP 草稿"}>
      <form onSubmit={submit}>
        <fieldset className="tool-form-fields" disabled={action.pending}>
          <label htmlFor={`${formId}-displayName`} className="agent-field">
            <span>显示名称</span>
            <Input
              id={`${formId}-displayName`}
              name="displayName"
              required
              maxLength={200}
              defaultValue={draft?.displayName}
            />
          </label>
          <label htmlFor={`${formId}-serverName`} className="agent-field">
            <span>Server 名称</span>
            <Input
              id={`${formId}-serverName`}
              name="serverName"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}"
              defaultValue={draft?.serverName}
            />
            <small>用于生成模型可见的工具名，例如 mcp__docs__search。</small>
          </label>
          <label htmlFor={`${formId}-endpoint`} className="agent-field">
            <span>HTTPS 端点</span>
            <Input
              id={`${formId}-endpoint`}
              name="endpoint"
              type="url"
              required
              pattern="https://.+"
              maxLength={2048}
              readOnly={draft?.credentialConfigured}
              defaultValue={draft?.endpoint}
              placeholder="https://mcp.example.invalid/tools"
            />
            {draft?.credentialConfigured && (
              <small>此端点已绑定凭据。请先清除草稿凭据，再修改端点。</small>
            )}
          </label>
          <Space wrap>
            <label htmlFor={`${formId}-timeoutMs`} className="agent-field">
              <span>超时（毫秒）</span>
              <Input
                type="number"
                id={`${formId}-timeoutMs`}
                name="timeoutMs"
                required
                min={100}
                max={120000}
                defaultValue={draft?.timeoutMs ?? 10000}
              />
            </label>
            <label htmlFor={`${formId}-maxResponseBytes`} className="agent-field">
              <span>响应上限（字节）</span>
              <Input
                type="number"
                id={`${formId}-maxResponseBytes`}
                name="maxResponseBytes"
                required
                min={1}
                max={1048576}
                defaultValue={draft?.maxResponseBytes ?? 65536}
              />
            </label>
          </Space>
          <label className="agent-field">
            <span>副作用</span>
            <select name="sideEffect" defaultValue={draft?.sideEffect ?? "write"}>
              <option value="read_only">只读</option>
              <option value="write">写入</option>
              <option value="destructive">破坏性操作</option>
            </select>
          </label>
          <label>
            <input type="checkbox" name="idempotent" defaultChecked={draft?.idempotent} />{" "}
            工具支持幂等调用
          </label>
          {!draft && <Typography.Text type="secondary">保存草稿后可单独写入凭据。</Typography.Text>}
          {action.error && <Alert type="error" title={action.error} />}
          <Space>
            <Button type="primary" htmlType="submit" loading={action.pending}>
              保存草稿
            </Button>
            <Button onClick={onCancel}>取消</Button>
          </Space>
        </fieldset>
      </form>
    </Card>
  );
}

export function HttpPreviewPage({ api }: { api: ExternalToolApiContract }) {
  const [mode, setMode] = useState<"endpoint" | "openapi">("endpoint");
  const [preview, setPreview] = useState<AdminHttpToolPreview>();
  const formId = useId();
  const action = useToolAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPreview(undefined);
    let object: Record<string, unknown>;
    try {
      object = JSON.parse(value(data, "json"));
      if (!object || typeof object !== "object" || Array.isArray(object)) throw new TypeError();
    } catch {
      action.setError("请输入有效的 JSON 对象。");
      return;
    }
    const common = {
      toolName: value(data, "toolName").trim(),
      description: value(data, "description").trim(),
    };
    void action.run(async () =>
      setPreview(
        await api.previewHttpTool(
          mode === "openapi"
            ? { ...common, mode, document: object }
            : {
                ...common,
                mode,
                inputSchema: object,
                endpoint: value(data, "endpoint").trim(),
                method: data.get("method") === "GET" ? "GET" : "POST",
              },
        ),
      ),
    );
  }
  return (
    <div className="agent-page">
      <Link to="/external-tools">返回外部工具</Link>
      <Card title="HTTP 工具预览">
        <form
          onSubmit={submit}
          onChange={() => {
            setPreview(undefined);
            action.setError("");
          }}
        >
          <fieldset className="tool-form-fields" disabled={action.pending}>
            <Typography.Text type="secondary">
              预览不会发布版本，不能在 Agent 中选择。HTTP 工具发布即将支持。
            </Typography.Text>
            <label className="agent-field">
              <span>声明方式</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value === "openapi" ? "openapi" : "endpoint")}
              >
                <option value="endpoint">单个端点</option>
                <option value="openapi">OpenAPI 片段</option>
              </select>
            </label>
            <label htmlFor={`${formId}-toolName`} className="agent-field">
              <span>工具名称</span>
              <Input id={`${formId}-toolName`} name="toolName" required maxLength={64} />
            </label>
            <label htmlFor={`${formId}-description`} className="agent-field">
              <span>工具描述</span>
              <Input id={`${formId}-description`} name="description" maxLength={2048} />
            </label>
            {mode === "endpoint" && (
              <>
                <label htmlFor={`${formId}-endpoint`} className="agent-field">
                  <span>HTTPS 端点</span>
                  <Input
                    id={`${formId}-endpoint`}
                    name="endpoint"
                    type="url"
                    required
                    pattern="https://.+"
                  />
                </label>
                <label className="agent-field">
                  <span>HTTP 方法</span>
                  <select name="method">
                    <option>GET</option>
                    <option>POST</option>
                  </select>
                </label>
              </>
            )}
            <label htmlFor={`${formId}-json`} className="agent-field">
              <span>{mode === "openapi" ? "OpenAPI 片段" : "参数 Schema"}（JSON）</span>
              <Input.TextArea
                key={mode}
                id={`${formId}-json`}
                name="json"
                rows={6}
                required
                defaultValue={
                  mode === "endpoint"
                    ? '{"type":"object","properties":{},"additionalProperties":false}'
                    : ""
                }
              />
            </label>
            {action.error && <Alert type="error" title={action.error} />}
            <div>
              <Button type="primary" htmlType="submit" loading={action.pending}>
                生成预览
              </Button>
            </div>
          </fieldset>
        </form>
      </Card>
      {preview && (
        <Card title={preview.modelToolName}>
          <div className="agent-fields">
            <strong>
              {preview.method} {preview.endpoint}
            </strong>
            <span>{preview.description}</span>
            <span>参数 Schema 摘要：{preview.inputSchemaDigest}</span>
            <pre>{JSON.stringify(preview.inputSchema, null, 2)}</pre>
          </div>
        </Card>
      )}
    </div>
  );
}
