import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ChatWidget, type ChatWidgetProps } from "./chat-widget.js";

export { AssistantMarkdown } from "./markdown-view.js";
export { AssistantMessage } from "./assistant-message.js";
export { ChatWidget } from "./chat-widget.js";
export type { AssistantMessageProps } from "./assistant-message.js";
export type {
  ChatLocale,
  ChatMessage,
  ChatTheme,
  ChatWidgetProps,
} from "./chat-widget.js";

export function mount(element: Element, options: ChatWidgetProps): { unmount: () => void } {
  const root: Root = createRoot(element);
  root.render(<ChatWidget {...options} />);
  return { unmount: () => root.unmount() };
}
