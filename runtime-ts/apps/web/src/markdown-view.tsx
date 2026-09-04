import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useMemo, useRef, type ReactNode } from "react";
import type { Root, RootContent } from "mdast";
import { MarkdownStream } from "./markdown-stream.js";

const markdownComponents: Components = {
  a: ({ node, href, children, ...props }) => {
    void node;
    if (!href) return <span className="markdown-invalid-link">{children}</span>;
    if (/(?:^|\/)resource_version_[a-z0-9]+(?:[?#].*)?$/iu.test(href)) {
      // Runtime 资源引用并不是稳定路由；真实下载能力由紧邻正文的 Artifact 卡片提供。
      return <span className="markdown-artifact-reference">{children}</span>;
    }
    const opensNewWindow = /^(?:https?:)?\/\//i.test(href);
    return (
      <a
        {...props}
        href={href}
        rel={opensNewWindow ? "noopener noreferrer" : undefined}
        target={opensNewWindow ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ node, alt }) => {
    void node;
    // 模型文本不能触发浏览器向任意第三方地址发起图片请求，图片语法退化为可读文本。
    return <span className="markdown-image-alt">[图片：{alt?.trim() || "未命名"}]</span>;
  },
  input: ({ node, type, checked, ...props }) => {
    void node;
    if (type !== "checkbox") return null;
    return (
      <input
        {...props}
        aria-label={checked ? "任务已完成" : "任务未完成"}
        checked={checked === true}
        disabled
        type="checkbox"
      />
    );
  },
};

const MarkdownPiece = memo(function MarkdownPiece({ node }: { readonly node: RootContent }) {
  if (node.type === "code")
    return <CodeLines text={node.value} language={node.lang ?? undefined} />;
  const tree: Root = { type: "root", children: [node] };
  // 使用既有 ReactMarkdown 安全出口；只把已解析的当前块交给转换器。
  return (
    <ReactMarkdown
      components={markdownComponents}
      remarkPlugins={[() => () => tree]}
      skipHtml
      urlTransform={defaultUrlTransform}
    >
      {""}
    </ReactMarkdown>
  );
});

function CodeLines({
  text,
  language,
}: {
  readonly text: string;
  readonly language: string | undefined;
}) {
  const retained = useRef({ previous: "", offset: 0, groups: [] as ReactNode[] });
  const cached = retained.current;
  if (!text.startsWith(cached.previous)) {
    cached.offset = 0;
    cached.groups = [];
  }
  cached.previous = text;
  let cursor = cached.offset;
  for (let count = 0; ; ) {
    const newline = text.indexOf("\n", cursor);
    if (newline < 0) break;
    cursor = newline + 1;
    if (++count !== 32) continue;
    cached.groups = [
      ...cached.groups,
      <span key={cached.offset}>{text.slice(cached.offset, cursor)}</span>,
    ];
    cached.offset = cursor;
    count = 0;
  }
  return (
    <pre>
      <code className={language === undefined ? undefined : `language-${language}`}>
        {cached.groups}
        <span key={cached.offset}>{text.slice(cached.offset)}</span>
        {text.length > 0 ? "\n" : ""}
      </code>
    </pre>
  );
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false,
}: {
  readonly text: string;
  readonly streaming?: boolean;
}) {
  const retained = useRef<MarkdownStream | undefined>(undefined);
  retained.current ??= new MarkdownStream();
  const blocks = useMemo(() => retained.current?.update(text, streaming), [text, streaming]);
  return (
    <div className="assistant-markdown">
      {blocks === undefined ? (
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={defaultUrlTransform}
        >
          {text}
        </ReactMarkdown>
      ) : (
        blocks.map((block) => <MarkdownPiece key={block.key} node={block.node} />)
      )}
    </div>
  );
});
