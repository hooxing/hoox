import { HooxClient } from "@hoox/sdk";
import { mount } from "@hoox/chat-ui";
import "@hoox/ui-theme/theme.css";
import "@hoox/chat-ui/styles.css";

const client = new HooxClient({ baseUrl: `${location.origin}/hoox` });
const host = document.querySelector<HTMLElement>("#chat");
if (!host) throw new Error("找不到聊天容器");
mount(host, {
  client,
  agentDefinitionId: "agent_REPLACE_WITH_PUBLISHED_ID",
  locale: "zh-CN",
  theme: { accentColor: "#315d51", borderRadius: "14px" },
  tools: {
    show_account_name: async () => "当前登录用户",
  },
});

document.querySelector<HTMLButtonElement>("#login")?.addEventListener("click", async () => {
  await fetch("/demo-session", { method: "POST", credentials: "same-origin" });
});
