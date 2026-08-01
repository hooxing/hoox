import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

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

export function AssistantMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
