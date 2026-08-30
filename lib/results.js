import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const MAX_FAILURES = 100;
const MAX_ERROR_LENGTH = 4000;
function xmlDecode(value) {
    return value
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&');
}
function stripXml(value) {
    return xmlDecode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function attr(openTag, name) {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'is');
    const match = pattern.exec(openTag);
    return match ? xmlDecode(match[2] ?? '') : '';
}
function parseTestcases(xml) {
    let cases = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];
    const testcaseRegex = /<testcase\b[\s\S]*?(?:\/>|>[\s\S]*?<\/testcase>)/gi;
    let match;
    while ((match = testcaseRegex.exec(xml)) !== null) {
        const block = match[0];
        cases += 1;
        const open = /^<testcase\b[^>]*>/i.exec(block)?.[0] ?? block;
        const testClass = attr(open, 'classname');
        const testName = attr(open, 'name');
        const isSkipped = /<skipped\b/i.test(block);
        const outcome = /<(failure|error)\b/i.exec(block);
        if (isSkipped) {
            skipped += 1;
            continue;
        }
        if (outcome) {
            failed += 1;
            if (failures.length < MAX_FAILURES) {
                const tag = outcome[1]?.toLowerCase() ?? 'failure';
                const tagRegex = new RegExp(`<${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, 'i');
                const failureBlock = tagRegex.exec(block)?.[0] ?? '';
                const failureMessage = attr(failureBlock, 'message');
                const bodyMatch = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(failureBlock);
                const body = bodyMatch ? stripXml(bodyMatch[1] ?? '') : '';
                const error = (failureMessage || body || 'Test failed; see the Gradle report/output.').slice(0, MAX_ERROR_LENGTH);
                failures.push({
                    testClass: testClass || 'UnknownTestClass',
                    testName: testName || 'UnknownTest',
                    error,
                });
            }
        }
    }
    return { cases, failed, skipped, failures };
}
function parseSuiteFallback(xml) {
    let total = 0;
    let failed = 0;
    let skipped = 0;
    const suiteRegex = /<testsuite\b[^>]*>/gi;
    let match;
    while ((match = suiteRegex.exec(xml)) !== null) {
        const tag = match[0];
        total += Number(attr(tag, 'tests') || 0);
        failed += Number(attr(tag, 'failures') || 0) + Number(attr(tag, 'errors') || 0);
        skipped += Number(attr(tag, 'skipped') || 0);
    }
    return { total, failed, skipped };
}
function walkReportFiles(dir, output, depth) {
    if (depth > 3)
        return;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            walkReportFiles(full, output, depth + 1);
        }
        else if (entry.isFile() && /^TEST-.*\.xml$/i.test(entry.name)) {
            output.push(full);
        }
    }
}
export function reportDirectory(projectRoot, modulePath, taskName) {
    const moduleDirectory = modulePath
        ? modulePath.slice(1).split(':').filter(Boolean).join('/')
        : '';
    return join(projectRoot, moduleDirectory, 'build', 'test-results', taskName);
}
export function collectReportFiles(projectRoot, modulePath, taskName) {
    const files = [];
    walkReportFiles(reportDirectory(projectRoot, modulePath, taskName), files, 0);
    return files.sort();
}
export function parseReports(files, minimumMtimeMs) {
    let total = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];
    let usableReports = 0;
    for (const file of files) {
        let xml;
        try {
            const stat = statSync(file);
            if (minimumMtimeMs !== undefined && stat.mtimeMs < minimumMtimeMs)
                continue;
            xml = readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        const parsed = parseTestcases(xml);
        if (parsed.cases > 0) {
            usableReports += 1;
            total += parsed.cases;
            failed += parsed.failed;
            skipped += parsed.skipped;
            failures.push(...parsed.failures);
        }
        else {
            const fallback = parseSuiteFallback(xml);
            if (fallback.total > 0) {
                usableReports += 1;
                total += fallback.total;
                failed += fallback.failed;
                skipped += fallback.skipped;
            }
        }
        if (failures.length >= MAX_FAILURES)
            break;
    }
    const cappedFailures = failures.slice(0, MAX_FAILURES);
    return {
        reportFiles: files.length,
        usableReports,
        total,
        passed: Math.max(0, total - failed - skipped),
        failed,
        skipped,
        failuresList: cappedFailures,
    };
}
export function emptySummary() {
    return { total: 0, passed: 0, failed: 0, skipped: 0, failuresList: [], reportFiles: 0, usableReports: 0 };
}
