export interface TestFailure {
    testClass: string;
    testName: string;
    error: string;
}
export interface TestSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failuresList: TestFailure[];
}
export interface ReportParseResult extends TestSummary {
    reportFiles: number;
    usableReports: number;
}
export declare function reportDirectory(projectRoot: string, modulePath: string, taskName: string): string;
export declare function collectReportFiles(projectRoot: string, modulePath: string, taskName: string): string[];
export declare function parseReports(files: string[], minimumMtimeMs?: number): ReportParseResult;
export declare function emptySummary(): TestSummary;
