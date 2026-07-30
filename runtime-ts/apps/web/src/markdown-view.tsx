import type { Components } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const markdownComponents: Components = {
  a: ({ node, href, ...props }) => {
    void node;
    const opensNewWindow = /^(?:https?:)?\/\//i.test(href ?? "");
    return (
      <a
        {...props}
        href={href}
        rel={opensNewWindow ? "noopener noreferrer" : undefined}
        target={opensNewWindow ? "_blank" : undefined}
      />
    );
  },
  img: ({ node, alt }) => {
    void node;
    // 模型文本不能触发浏览器向任意第三方地址发起图片请求，图片语法退化为可读文本。
    return <span className="markdown-image-alt">[图片：{alt?.trim() || "未命名"}]</span>;
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
