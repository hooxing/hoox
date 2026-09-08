// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("工作台滚动区域样式", () => {
  it("会话列表和运行内容保留滚动能力但不显示滚动条", () => {
    expect(styles).toMatch(
      /\.thread-list\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*none;/su,
    );
    expect(styles).toMatch(
      /\.run-area\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*none;/su,
    );
    expect(styles).toContain(".thread-list::-webkit-scrollbar");
    expect(styles).toContain(".run-area::-webkit-scrollbar");
  });

  it("不再包含右侧活动栏布局", () => {
    expect(styles).not.toContain(".activity-panel");
    expect(styles).not.toContain(".activity-scroll");
  });

  it("桌面端使用轻量任务栏、窄正文和与输入框衔接的进度区", () => {
    expect(styles).toMatch(/grid-template-columns:\s*272px minmax\(0, 1fr\)/u);
    expect(styles).toMatch(/\.run-area\s*\{[^}]*width:\s*min\(100%, 840px\)/su);
    expect(styles).toMatch(/\.composer\s*\{[^}]*840px[^}]*border-radius:\s*var\(--radius-lg\)/su);
    expect(styles).toMatch(/\.run-progress-dock\s*\{[^}]*840px/su);
    expect(styles).toContain(".run-progress-dock + .composer");
  });

  it("输入区以表面和单层阴影建立边界，聚焦时不叠加描边", () => {
    expect(styles).toMatch(
      /\.composer\s*\{[^}]*border:\s*0;[^}]*background:\s*var\(--surface-raised\);[^}]*box-shadow:\s*var\(--shadow-control\);/su,
    );
    expect(styles).toMatch(
      /\.composer:focus-within\s*\{[^}]*box-shadow:\s*0 4px 6px hsla\(0, 0%, 0%, 0\.2\);/su,
    );
    expect(styles).toMatch(
      /\.composer textarea\s*\{[^}]*border:\s*0;[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/su,
    );
    expect(styles).not.toMatch(/\.composer:focus-within\s*\{[^}]*(?:focus-color|focus-ring)/su);
  });

  it("外壳组件引用共享语义 Token 并提供明确禁用态", () => {
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--surface-sidebar\)/su);
    expect(styles).toMatch(/\.thread\.selected\s*\{[^}]*var\(--action-subtle\)/su);
    expect(styles).toMatch(/\.send-button\s*\{[^}]*var\(--action-primary\)/su);
    expect(styles).toMatch(/\.send-button:disabled\s*\{[^}]*opacity:\s*1;/su);
  });

  it("品牌绿只通过横版 Logo 稀缺出现，选中态与主要操作保持语义解耦", () => {
    expect(styles).toMatch(
      /\.brand-logo\s*\{[^}]*width:\s*132px;[^}]*height:\s*40px;[^}]*object-fit:\s*cover;/su,
    );
    expect(styles).toMatch(
      /\.welcome-logo\s*\{[^}]*width:\s*min\(256px, 100%\);[^}]*aspect-ratio:\s*4 \/ 1;[^}]*object-fit:\s*cover;/su,
    );
    expect(styles).not.toContain(".brand-copy");
    expect(styles).not.toContain(".welcome-mark");
    expect(styles).not.toContain("#177053");
    expect(styles).not.toContain("#d9f2e4");
  });

  it("外壳主要点击目标至少为 40px", () => {
    expect(styles).toMatch(/\.new-thread-button\s*\{[^}]*min-height:\s*40px;/su);
    expect(styles).toMatch(/\.icon-button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/su);
    expect(styles).toMatch(
      /\.personal-thread-actions button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/su,
    );
    expect(styles).toMatch(/\.quiet-button\s*\{[^}]*min-height:\s*40px;/su);
    expect(styles).toMatch(/\.send-button\s*\{[^}]*width:\s*40px;[^}]*min-height:\s*40px;/su);
  });

  it("状态栏不保留历史轨道，思考文本使用轻量披露区", () => {
    expect(styles).not.toContain(".run-progress-track");
    expect(styles).not.toContain(".run-progress-count");
    expect(styles).not.toContain(".run-progress-disclosures");
    expect(styles).not.toContain(".run-progress-history");
    expect(styles).toMatch(/\.run-thinking\s*\{[^}]*margin-top:/su);
    expect(styles).toMatch(/\.run-thinking-content\s*\{[^}]*overflow:\s*auto;/su);
    expect(styles).not.toMatch(/\.run-thinking-content\s*\{[^}]*max-height:/su);
    expect(styles).not.toMatch(/\.run-thinking-content\s*\{[^}]*border:/su);
    expect(styles).not.toMatch(/\.run-thinking-content\s*\{[^}]*background:/su);
    expect(styles).toContain(".run-thinking-content::-webkit-scrollbar");
    expect(styles).toContain(".run-thinking + .assistant-markdown");
    expect(styles).not.toContain(".run-thinking-indicator");
    expect(styles).not.toContain(".when-expanded");
    expect(styles).toContain(".run-thinking-content:focus-visible");
  });

  it("超长用户请求不会按最小内容宽度撑开消息行", () => {
    expect(styles).toMatch(/\.message\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/su);
    expect(styles).toMatch(
      /\.user-request \.message-card\s*\{[^}]*max-width:\s*min\(78%, 700px\);[^}]*overflow-wrap:\s*anywhere;/su,
    );
  });

  it("用户附件位于消息气泡上方并限制为紧凑宽度", () => {
    expect(styles).toMatch(
      /\.user-request-attachments\s*\{[^}]*width:\s*min\(78%, 700px\);[^}]*justify-content:\s*flex-end;/su,
    );
    expect(styles).toMatch(
      /\.user-request-attachment\s*\{[^}]*width:\s*min\(280px, 100%\);[^}]*min-height:\s*44px;/su,
    );
    expect(styles).toMatch(
      /\.user-request-attachment-preview\s*\{[^}]*width:\s*46px;[^}]*height:\s*46px;/su,
    );
  });

  it("超长用户请求采用接近 ChatGPT 的默认折叠高度和渐隐范围", () => {
    expect(styles).toMatch(
      /\.user-request-content\.is-collapsed\s*\{[^}]*max-height:\s*264px;[^}]*overflow:\s*clip;[^}]*mask-image:\s*linear-gradient\(#000 calc\(100% - 48px\), transparent\);/su,
    );
    expect(styles).toMatch(
      /\.user-request-toggle\s*\{[^}]*min-height:\s*24px;[^}]*margin-top:\s*6px;/su,
    );
  });
});
