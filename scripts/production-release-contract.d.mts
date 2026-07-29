export const productionNodeBaseDigest: string;

export interface ProductionReleaseInputs {
  readonly dockerignore: string;
  readonly apiDockerfile: string;
  readonly schedulerDockerfile: string;
  readonly workerDockerfile: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly checklist: string;
  readonly packageJson: Readonly<Record<string, unknown>>;
  readonly scripts: string;
}

export function validateProductionReleaseInputs(input: ProductionReleaseInputs): string[];
export function validateProductionReleaseContract(): string[];
