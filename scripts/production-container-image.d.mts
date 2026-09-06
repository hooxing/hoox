export function acquireProductionGateImage(
  runDocker: (arguments_: string[], options: { capture: true }) => string,
  dockerfile: string,
  prebuiltImage?: string,
): { imageId: string; removeImage: boolean };
