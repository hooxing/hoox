import type { WorkspaceRevisionId } from "@aisay/domain";
import type { ArtifactPublicationPort, ExecutionScope } from "@aisay/run-contracts";
import { ArtifactDeliveryError, artifactError } from "./errors.js";

/** ArtifactService 暴露给 RunWorker 的只读完成门，不把写能力带进 Worker 终态路径。 */
export class ArtifactCompletionGateAdapter implements ArtifactPublicationPort {
  constructor(private readonly service: Pick<ArtifactPublicationPort, "assertReadyForCompletion">) {
    if (!service || typeof service.assertReadyForCompletion !== "function") {
      throw artifactError("ARTIFACT_NOT_READY", "必需交付物尚未全部发布成功");
    }
  }

  async assertReadyForCompletion(input: {
    readonly scope: ExecutionScope;
    readonly workspaceRevisionId?: WorkspaceRevisionId;
  }): Promise<void> {
    try {
      await this.service.assertReadyForCompletion(input);
    } catch (error) {
      if (error instanceof ArtifactDeliveryError && error.code === "ARTIFACT_NOT_READY") {
        throw error;
      }
      // 完成路径永不向 RunWorker 暴露 Repository、对象键或存储端错误。
      throw artifactError("ARTIFACT_NOT_READY", "必需交付物尚未全部发布成功");
    }
  }
}
