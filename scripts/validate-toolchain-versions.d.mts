export interface ToolchainVersionInputs {
  readonly packageJson: {
    readonly engines?: { readonly node?: string };
    readonly packageManager?: string;
    readonly scripts?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  readonly nodeVersionFile: string;
  readonly nvmrc: string;
  readonly ciWorkflow: string;
  readonly dockerfiles: readonly {
    readonly name: string;
    readonly content: string;
  }[];
}

export declare function readToolchainVersionInputs(): ToolchainVersionInputs;
export declare function validateToolchainVersions(input: ToolchainVersionInputs): string[];
export declare function validateToolchainVersionContract(): string[];
