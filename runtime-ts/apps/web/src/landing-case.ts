import type { Artifact, Run, ThreadContextMessage } from "./api.js";

// 只收录获授权公开的任务名、文件名与编辑摘要；标识和时间为展示常量，不复制生产任务或模型日志。
const createdAt = "2026-10-03T00:00:00.000Z";
export const bookRun: Run = {
  id: "public-book-run",
  threadId: "public-book-thread",
  status: "succeeded",
  createdAt,
  updatedAt: createdAt,
};
export const bookMessages: readonly ThreadContextMessage[] = [
  {
    sequence: 1,
    role: "user",
    runId: bookRun.id,
    createdAt,
    text: "帮我整理一份思维导图",
    attachments: [
      {
        resourceId: "public-book-resource",
        versionId: "public-book-version",
        name: "国富论.epub",
        mediaType: "application/epub+zip",
        sizeBytes: 1258291,
      },
    ],
  },
  {
    sequence: 2,
    role: "assistant",
    runId: bookRun.id,
    createdAt,
    phase: "final_answer",
    text: "已通读全书并整理完成，为你准备了 **两份思维导图**。\n\n- **HTML 交互导图**：展开与折叠、缩放与平移，在浏览器中探索全书结构。\n- **Markdown 大纲**：导入思维导图工具，继续编辑与整理。\n\n从分工与价值、资本积累，到经济史、政治经济学体系与财政学，梳理全书五篇的核心脉络。",
  },
];
export const bookArtifacts: readonly Artifact[] = [
  {
    id: "public-book-html",
    name: "国富论-思维导图.html",
    mediaType: "text/html",
    status: "published",
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: "public-book-md",
    name: "国富论-思维导图.md",
    mediaType: "text/markdown",
    status: "published",
    createdAt,
    updatedAt: createdAt,
  },
];
