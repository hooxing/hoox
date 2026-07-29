/** 只有无主动内容的纯文本扩展名可进入 API inline preview 白名单。 */
export function workspaceArtifactMediaType(relativePath: string): string {
  return relativePath.toLowerCase().endsWith(".txt")
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}
