export interface ProcessResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
}
export declare function runGradle(projectRoot: string, gradleArgs: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<ProcessResult>;
export declare function detectDefaultModule(projectRoot: string): string;
export declare function normalizeModule(projectRoot: string, value: string | undefined): string;
export declare function normalizeVariant(value: string | undefined): string;
export declare function normalizeFilter(value: string | undefined): string | undefined;
export declare function buildTask(modulePath: string, variant: string): string;
export declare function wrapperExists(projectRoot: string): boolean;
