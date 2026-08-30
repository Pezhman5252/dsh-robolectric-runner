import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { statSync } from 'node:fs'

import {
  buildTask,
  normalizeFilter,
  normalizeModule,
  normalizeVariant,
  runGradle,
  wrapperExists,
} from './gradle.js'
import {
  collectReportFiles,
  emptySummary,
  parseReports,
  type ReportParseResult,
  type TestFailure,
} from './results.js'

export const name = 'dsh-robolectric-runner'
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 900_000
const MAX_FAILURES = 100
const MAX_FILTERS = 100

interface ToolArgs {
  module?: string
  variant?: string
  testFilter?: string
  rerunFailed?: boolean
  timeoutMs?: number
}

interface ToolResult {
  success: boolean
  executionStatus: 'passed' | 'failed' | 'no_previous_failures' | 'cancelled' | 'timeout' | 'execution_error' | 'parse_error'
  message: string
  projectRoot: string
  gradleTask: string
  selectedFilters: string[]
  summary: ReportParseResult
  rawOutputTail: string
}

function clampTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}.`)
  }
  return timeoutMs
}

function outputTail(stdout: string, stderr: string): string {
  const text = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim()
  return text.length <= 6000 ? text : text.slice(-6000)
}

function sessionCwd(execCtx: any): string {
  const cwd = execCtx?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('The active DSH session has no workspace/cwd. Start the tool from an active project session.')
  }
  const stat = statSync(cwd)
  if (!stat.isDirectory()) throw new Error('The active DSH session cwd is not a directory.')
  return cwd
}

function uniqueFilters(failures: TestFailure[]): string[] {
  const result: string[] = []
  for (const failure of failures) {
    const filter = `${failure.testClass}.${failure.testName}`
    if (!result.includes(filter)) result.push(filter)
    if (result.length >= MAX_FILTERS) break
  }
  return result
}

export function apply(ctx: Context) {
  const logger = ctx.logger(name)

  ctx.tools.register(defineTool({
    name: 'run_robolectric',
    description:
      'Run Android local JVM unit tests with the project Gradle wrapper. Use for Robolectric tests and ordinary Android local JVM tests; do not use for instrumentation/device tests. The tool uses the active DSH session workspace, validates module/variant/filter inputs, runs Gradle without an arbitrary shell command, reads Gradle XML test reports, and can rerun only previously failed/error tests.',
    parameters: {
      module: {
        type: 'string',
        description: 'Optional Android Gradle module path, for example "app" or ":feature:login". If omitted, the tool detects a likely Android module.',
      },
      variant: {
        type: 'string',
        description: 'Optional Android build variant such as "Debug", "Release", or "BenchmarkDebug". Defaults to "Debug".',
      },
      testFilter: {
        type: 'string',
        description: 'Optional Gradle --tests selector, for example "com.example.LoginTest" or "com.example.LoginTest.login". Do not include shell syntax or spaces.',
      },
      rerunFailed: {
        type: 'boolean',
        description: 'When true, read the previous XML reports for the same Gradle task and rerun only failed/error test cases. Do not combine this with testFilter.',
      },
      timeoutMs: {
        type: 'number',
        description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; allowed range is 1000-${MAX_TIMEOUT_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          executionStatus: { type: 'string', required: true },
          message: { type: 'string', required: true },
          projectRoot: { type: 'string', required: true },
          gradleTask: { type: 'string', required: true },
          selectedFilters: { type: 'array', required: true, items: { type: 'string' } },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'number', required: true },
              passed: { type: 'number', required: true },
              failed: { type: 'number', required: true },
              skipped: { type: 'number', required: true },
              reportFiles: { type: 'number', required: true },
              usableReports: { type: 'number', required: true },
              failuresList: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    testClass: { type: 'string', required: true },
                    testName: { type: 'string', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          rawOutputTail: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const result = value as ToolResult
        const lines = [
          '📊 **Android Local JVM / Robolectric Results**',
          '',
          `- **Status:** ${result.success ? '✅ Passed' : '❌ Not fully successful'}`,
          `- **Execution:** ${result.executionStatus}`,
          `- **Task:** ${result.gradleTask}`,
          `- **Summary:** ${result.message}`,
          `- **Tests:** ${result.summary.total} total, ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
          `- **Reports:** ${result.summary.usableReports} usable of ${result.summary.reportFiles} XML file(s)`,
        ]
        if (result.selectedFilters.length) lines.push(`- **Filters:** ${result.selectedFilters.join(', ')}`)
        if (result.summary.failuresList.length) {
          lines.push('', '**Failures:**')
          for (const failure of result.summary.failuresList) {
            lines.push(`- ${failure.testClass}#${failure.testName}\n  ${failure.error.replace(/\s+/g, ' ').slice(0, 1200)}`)
          }
        }
        if (result.rawOutputTail) lines.push('', '**Gradle output tail:**', '```text', result.rawOutputTail, '```')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: ToolArgs, execCtx: any): Promise<ToolResult> {
      const projectRoot = sessionCwd(execCtx)
      const timeoutMs = clampTimeout(args.timeoutMs)
      if (args.rerunFailed && args.testFilter) {
        throw new Error('rerunFailed and testFilter cannot be used together. Use rerunFailed alone to rerun the previous failing tests.')
      }
      if (!wrapperExists(projectRoot)) {
        throw new Error(`Gradle wrapper not found in the active session workspace: ${process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'}`)
      }

      const modulePath = normalizeModule(projectRoot, args.module)
      const variant = normalizeVariant(args.variant)
      const explicitFilter = normalizeFilter(args.testFilter)
      const task = buildTask(modulePath, variant)
      const taskName = task.split(':').filter(Boolean).at(-1) ?? task
      let selectedFilters: string[] = explicitFilter ? [explicitFilter] : []

      if (args.rerunFailed) {
        const previousFiles = collectReportFiles(projectRoot, modulePath, taskName)
        const previous = parseReports(previousFiles)
        selectedFilters = uniqueFilters(previous.failuresList)
        if (!selectedFilters.length) {
          return {
            success: true,
            executionStatus: 'no_previous_failures',
            message: 'No previous failed/error test cases were found for this Gradle task; nothing was rerun.',
            projectRoot,
            gradleTask: task,
            selectedFilters: [],
            summary: emptySummary(),
            rawOutputTail: '',
          }
        }
      }

      const gradleArgs = [task]
      for (const filter of selectedFilters) gradleArgs.push('--tests', filter)
      gradleArgs.push('--rerun-tasks', '--no-daemon', '--console=plain')

      logger.info(`Running ${task} in ${projectRoot}`)
      const startedAt = Date.now()
      let run
      try {
        run = await runGradle(projectRoot, gradleArgs, timeoutMs, execCtx.signal)
      } catch (error) {
        logger.error(String(error))
        return {
          success: false,
          executionStatus: execCtx.signal?.aborted ? 'cancelled' : 'execution_error',
          message: `Unable to execute Gradle: ${String(error)}`,
          projectRoot,
          gradleTask: task,
          selectedFilters,
          summary: emptySummary(),
          rawOutputTail: '',
        }
      }

      const rawOutputTail = outputTail(run.stdout, run.stderr)
      if (run.timedOut) {
        return {
          success: false,
          executionStatus: 'timeout',
          message: `Gradle exceeded the ${timeoutMs} ms timeout.`,
          projectRoot,
          gradleTask: task,
          selectedFilters,
          summary: emptySummary(),
          rawOutputTail,
        }
      }
      if (run.aborted || execCtx.signal?.aborted) {
        return {
          success: false,
          executionStatus: 'cancelled',
          message: 'Gradle execution was cancelled.',
          projectRoot,
          gradleTask: task,
          selectedFilters,
          summary: emptySummary(),
          rawOutputTail,
        }
      }

      const reportFiles = collectReportFiles(projectRoot, modulePath, taskName)
      const summary = parseReports(reportFiles, startedAt - 2000)
      const hasAuthoritativeReports = summary.usableReports > 0

      if (!hasAuthoritativeReports) {
        return {
          success: false,
          executionStatus: run.exitCode === 0 ? 'parse_error' : 'failed',
          message:
            run.exitCode === 0
              ? 'Gradle completed, but no fresh XML test report could be parsed reliably.'
              : `Gradle exited with code ${run.exitCode ?? 'unknown'} and no fresh XML test report was available.`,
          projectRoot,
          gradleTask: task,
          selectedFilters,
          summary: emptySummary(),
          rawOutputTail,
        }
      }

      const success = run.exitCode === 0 && summary.failed === 0
      return {
        success,
        executionStatus: success ? 'passed' : 'failed',
        message: success
          ? `Gradle completed successfully. ${summary.total} tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`
          : `Gradle finished with exit code ${run.exitCode ?? 'unknown'}. ${summary.failed} failed/error tests were reported.`,
        projectRoot,
        gradleTask: task,
        selectedFilters,
        summary,
        rawOutputTail,
      }
    },
  }))
}
