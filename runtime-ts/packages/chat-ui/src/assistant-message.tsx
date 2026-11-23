import type { ReactNode } from "react";
import { AssistantMarkdown } from "./markdown-view.js";

export type AssistantMessageProps = {
  readonly text: string;
  readonly label?: string;
  readonly contentBefore?: ReactNode;
};

export function AssistantMessage({ text, label = "Hoox", contentBefore }: AssistantMessageProps) {
  return (
    <article className="message assistant-message" aria-label={label}>
      <span className="message-avatar" aria-hidden="true">
        H
      </span>
      <div className="message-card">
        <span className="message-label">{label}</span>
        {contentBefore}
        {text.length > 0 && <AssistantMarkdown text={text} />}
      </div>
    </article>
  );
}
