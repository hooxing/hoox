import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { developmentSession, persistAccountSession } from "../src/account-access.js";
import type { Artifact, Run, Thread } from "../src/api.js";
import { App } from "../src/main.js";

persistAccountSession(localStorage, developmentSession);
const date = "2026-09-08T00:00:00.000Z";
const thread: Thread = {
  id: "thread_preview",
  title: "交付文件预览验证",
  status: "active",
  createdAt: date,
  updatedAt: date,
};
const run: Run = {
  id: "run_preview",
  threadId: thread.id,
  status: "succeeded",
  createdAt: date,
  updatedAt: date,
};
const artifacts: Artifact[] = ["docx", "xlsx", "pptx", "pdf", "png", "txt", "md", "csv"].map(
  (extension) => ({
    id: `artifact_${extension}`,
    name: `sample.${extension}`,
    resourceVersionId: `version_${extension}`,
    status: "published",
    createdAt: date,
    updatedAt: date,
  }),
);
const api: NonNullable<ComponentProps<typeof App>["apiClient"]> = {
  listThreads: async () => [thread],
  listLatestRuns: async () => [run],
  getRun: async () => run,
  listArtifacts: async () => artifacts,
  listEvents: async () => ({ attemptId: undefined, items: [] }),
  listThreadContext: async () => [
    {
      role: "user",
      sequence: 1,
      text: "请检查这些附件",
      attachments: [
        {
          resourceId: "resource_docx",
          versionId: "version_docx",
          name: "这是一个用于验证超长文件名不会撑开消息区域的公告模板.docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 37_020,
        },
        {
          resourceId: "resource_image",
          versionId: "version_image",
          name: "示例图片.png",
          mediaType: "image/png",
          sizeBytes: 5_991,
        },
      ],
      createdAt: date,
    },
  ],
  createThread: async () => thread,
  createRun: async () => run,
  cancelRun: async () => run,
  archiveThread: async () => thread,
  downloadArtifact: async () => "/unused",
  previewArtifact: async () => ({ kind: "text", text: "兼容预览" }),
  previewHistoryFile: async () => "/browser-tests/fixtures/sample.png",
  readArtifactContent: async (source, signal) => {
    const response = await fetch(`/browser-tests/fixtures/${source.name}`, { signal });
    return response.arrayBuffer();
  },
  uploadResource: async (file) => ({
    resourceId: `resource_${crypto.randomUUID()}`,
    versionId: `version_${crypto.randomUUID()}`,
    name: file.name,
    mediaType: file.type,
    sizeBytes: file.size,
    path: "/resources/screenshot.png",
  }),
  submitThreadInput: async () => ({
    receiptId: crypto.randomUUID(),
    inputSequence: 1,
    requestedMode: "auto",
    disposition: "queued",
    createdAt: date,
    updatedAt: date,
  }),
};
const root = document.getElementById("preview-check");
if (root) createRoot(root).render(<App apiClient={api} />);
