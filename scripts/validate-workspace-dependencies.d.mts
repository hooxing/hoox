export interface WorkspaceDependencyRules {
  readonly allowedAppDependencies: Readonly<Record<string, readonly string[]>>;
  readonly forbiddenDependencies: Readonly<Record<string, readonly string[]>>;
}

export interface WorkspaceDependencyInputs {
  readonly rootManifest: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  readonly workspaces: readonly {
    readonly name: string;
    readonly kind: "app" | "package";
    readonly directory: string;
    readonly manifest: Readonly<Record<string, unknown>>;
    readonly files: readonly { readonly path: string; readonly specifiers: readonly string[] }[];
  }[];
}

export declare const workspaceDependencyRules: WorkspaceDependencyRules;
export declare function extractImportSpecifiers(source: string): string[];
export declare function packageNameOf(specifier: string): string | undefined;
export declare function readWorkspaceDependencyInputs(): WorkspaceDependencyInputs;
export declare function validateWorkspaceDependencies(
  input: WorkspaceDependencyInputs,
  rules?: WorkspaceDependencyRules,
): string[];
export declare function validateWorkspaceDependencyContract(): string[];
