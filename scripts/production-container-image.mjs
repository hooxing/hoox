export function acquireProductionGateImage(runDocker, dockerfile, prebuiltImage) {
  const suppliedImage = prebuiltImage?.trim();
  if (suppliedImage) {
    // 只解析已加载的本地镜像；所有后续探针固定使用不可变 ID，且不取得外部镜像的清理权。
    const imageId = runDocker(["image", "inspect", "--format", "{{.Id}}", suppliedImage], {
      capture: true,
    });
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("DOCKER_IMAGE_ID_INVALID");
    return { imageId, removeImage: false };
  }

  const buildOutput = runDocker(["build", "--quiet", "--file", dockerfile, "."], {
    capture: true,
  });
  // Windows Docker 偶发附带 named pipe 诊断；只在构建成功后提取完整 digest 行，避免清理任意输出。
  const imageId = /(?:^|\r?\n)(sha256:[a-f0-9]{64})(?:\r?\n|$)/u.exec(buildOutput)?.[1];
  if (imageId === undefined) throw new Error("DOCKER_IMAGE_ID_INVALID");
  return { imageId, removeImage: true };
}
