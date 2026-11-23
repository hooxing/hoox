import { ClientTools, type ArtifactDto, type ClientToolHandler, type HooxClient } from "@hoox/sdk";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { AssistantMarkdown } from "./markdown-view.js";

export type ChatLocale = "zh-CN" | "en";
export type ChatTheme = {
  readonly accentColor?: string;
  readonly backgroundColor?: string;
  readonly textColor?: string;
  readonly fontFamily?: string;
  readonly borderRadius?: string;
};
export type ChatMessage = {
  readonly id?: string;
  readonly role: "user" | "assistant";
  readonly content: string;
};
export type ChatWidgetProps = {
  readonly client: HooxClient;
  readonly agentDefinitionId: string;
  readonly threadId?: string;
  readonly initialMessages?: readonly ChatMessage[];
  readonly locale?: ChatLocale;
  readonly theme?: ChatTheme;
  readonly tools?: Readonly<Record<string, ClientToolHandler>>;
  readonly className?: string;
};

const copy = {
  "zh-CN": {
    send: "发送",
    placeholder: "输入消息…",
    working: "正在回复…",
    failed: "暂时无法完成请求，请重试。",
    artifacts: "文件与交付物",
    download: "下载",
    preview: "预览",
    openFile: "打开文件",
    tool: "正在处理页面操作…",
  },
  en: {
    send: "Send",
    placeholder: "Type a message…",
    working: "Replying…",
    failed: "The request could not be completed. Please try again.",
    artifacts: "Files and artifacts",
    download: "Download",
    preview: "Preview",
    openFile: "Open file",
    tool: "Handling page action…",
  },
} as const;

function requestKey(): string {
  return globalThis.crypto.randomUUID();
}

function safeDeliveryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("文件交付地址协议无效");
  }
  return url.href;
}

export function ChatWidget({
  client,
  agentDefinitionId,
  threadId: initialThreadId,
  initialMessages = [],
  locale = "zh-CN",
  theme,
  tools = {},
  className,
}: ChatWidgetProps) {
  const labels = copy[locale];
  const [threadId, setThreadId] = useState(initialThreadId);
  const [messages, setMessages] = useState<readonly ChatMessage[]>(() =>
    initialMessages.map((message) => ({ ...message, id: message.id ?? requestKey() })),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [error, setError] = useState(false);
  const [artifacts, setArtifacts] = useState<readonly ArtifactDto[]>([]);
  const [preview, setPreview] = useState<{ readonly text: string } | { readonly url: string }>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const clientTools = useMemo(() => {
    const registered = new ClientTools();
    for (const [name, handler] of Object.entries(tools)) {
      registered.register(name, async (argumentsValue, context) => {
        setToolBusy(true);
        try {
          return await handler(argumentsValue, context);
        } finally {
          setToolBusy(false);
        }
      });
    }
    return registered;
  }, [tools]);

  useEffect(() => () => controller.current?.abort(), []);

  const themeStyle: CSSProperties = {
    ...(theme?.accentColor ? { "--hoox-chat-accent": theme.accentColor } : {}),
    ...(theme?.backgroundColor ? { "--hoox-chat-background": theme.backgroundColor } : {}),
    ...(theme?.textColor ? { "--hoox-chat-text": theme.textColor } : {}),
    ...(theme?.fontFamily ? { "--hoox-chat-font": theme.fontFamily } : {}),
    ...(theme?.borderRadius ? { "--hoox-chat-radius": theme.borderRadius } : {}),
  } as CSSProperties;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = draft.trim();
    if (!input || busy) return;
    setBusy(true);
    setError(false);
    setPreview(undefined);
    setDownloadUrl(undefined);
    setDraft("");
    setMessages((current) => [
      ...current,
      { id: requestKey(), role: "user", content: input },
      { id: requestKey(), role: "assistant", content: "" },
    ]);
    const runController = new AbortController();
    controller.current = runController;
    try {
      const activeThreadId =
        threadId ??
        (
          await client.createThread(
            { title: input.slice(0, 120), agentDefinitionId },
            { idempotencyKey: requestKey(), signal: runController.signal },
          )
        ).id;
      if (!threadId) setThreadId(activeThreadId);
      const run = await client.createRun(
        activeThreadId,
        { input },
        {
          idempotencyKey: requestKey(),
          signal: runController.signal,
        },
      );
      for await (const event of clientTools.stream(client, activeThreadId, run.id, {
        signal: runController.signal,
        retry: { initialDelayMs: 100, maxDelayMs: 1_000, maxRetries: 8 },
      })) {
        if (event.event !== "run-events") continue;
        for (const item of event.data.page.items) {
          const payload = item.payload;
          if (item.type === "message.delta" && typeof payload.delta === "string") {
            setMessages((current) => {
              const last = current.at(-1);
              if (last?.role !== "assistant") return current;
              return [...current.slice(0, -1), { ...last, content: last.content + payload.delta }];
            });
          }
        }
        if (["succeeded", "failed", "cancelled"].includes(event.data.run.status)) {
          const result = await client.listArtifacts(activeThreadId, run.id, {
            signal: runController.signal,
          });
          setArtifacts(result.items);
        }
      }
    } catch {
      if (!runController.signal.aborted) {
        setDraft(input);
        setError(true);
      }
    } finally {
      if (controller.current === runController) controller.current = undefined;
      setBusy(false);
      setToolBusy(false);
    }
  }

  async function showPreview(artifact: ArtifactDto) {
    if (!threadId) return;
    try {
      const result = await client.previewArtifact(threadId, artifact.runId, artifact.id);
      if ("text" in result) setPreview({ text: result.text });
      else setPreview({ url: safeDeliveryUrl(result.url) });
    } catch {
      setError(true);
    }
  }

  async function download(artifact: ArtifactDto) {
    if (!threadId) return;
    try {
      const result = await client.downloadArtifact(threadId, artifact.runId, artifact.id);
      if ("url" in result) setDownloadUrl(safeDeliveryUrl(result.url));
      else setPreview({ text: result.text });
    } catch {
      setError(true);
    }
  }

  return (
    <section
      className={`hoox-chat ${className ?? ""}`}
      style={themeStyle}
      aria-label={locale === "en" ? "Chat" : "对话"}
    >
      <div className="hoox-chat-messages" aria-live="polite">
        {messages.map((message) => (
          <article className={`hoox-chat-message is-${message.role}`} key={message.id}>
            {message.role === "assistant" ? (
              <AssistantMarkdown
                text={message.content}
                streaming={busy && message.id === messages.at(-1)?.id}
              />
            ) : (
              <p>{message.content}</p>
            )}
          </article>
        ))}
        {busy && (
          <p className="hoox-chat-status" role="status">
            {toolBusy ? labels.tool : labels.working}
          </p>
        )}
        {error && (
          <p className="hoox-chat-error" role="alert">
            {labels.failed}
          </p>
        )}
      </div>
      {preview && (
        <section className="hoox-chat-preview" aria-label={labels.preview}>
          {"text" in preview ? (
            <pre>{preview.text}</pre>
          ) : (
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              {labels.openFile}
            </a>
          )}
          <button type="button" onClick={() => setPreview(undefined)}>
            ×
          </button>
        </section>
      )}
      {downloadUrl && (
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
          {labels.openFile}
        </a>
      )}
      {artifacts.length > 0 && (
        <section className="hoox-chat-artifacts" aria-label={labels.artifacts}>
          <h3>{labels.artifacts}</h3>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span>{artifact.name}</span>
                <button type="button" onClick={() => void showPreview(artifact)}>
                  {labels.preview}
                </button>
                <button type="button" onClick={() => void download(artifact)}>
                  {labels.download}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form className="hoox-chat-composer" onSubmit={(event) => void submit(event)}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {labels.send}
        </button>
      </form>
    </section>
  );
}
