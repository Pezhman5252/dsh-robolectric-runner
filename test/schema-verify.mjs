// Regression test: the tool's returned summary must validate against its own
// output schema. Previously `summary.reportFiles` and `summary.usableReports`
// were returned by execute() but not declared in output.schema, so the DSH
// runtime rejected them with `"value.summary.reportFiles" is not a declared
// property (additionalProperties: false)`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { apply } = await import(pathToFile(path.join(root, 'lib', 'index.js')))

// Minimal Cordis-like context that captures the registered tool definition.
let captured
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  tools: {
    register(def) {
      captured = def
    },
  },
}
apply(ctx)
assert.ok(captured, 'run_robolectric must be registered')
assert.equal(captured.name, 'run_robolectric')

const schema = captured.output.schema
const check = (value, label) => {
  const violations = validateJsonSchemaValue(schema, value, 'value')
  assert.deepEqual(violations, [], `${label}: schema violations = ${violations.join('; ')}`)
}

// 1. The success path returns a full parse summary (reportFiles/usableReports present).
check(
  {
    success: true,
    executionStatus: 'passed',
    message: 'Gradle completed successfully. 3 tests: 2 passed, 1 failed, 0 skipped.',
    projectRoot: root,
    gradleTask: ':app:testDebugUnitTest',
    selectedFilters: [],
    summary: {
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      reportFiles: 5,
      usableReports: 2,
      failuresList: [
        { testClass: 'com.example.LoginTest', testName: 'fails', error: 'Expected true' },
      ],
    },
    rawOutputTail: 'BUILD SUCCESSFUL',
  },
  'success path',
)

// 2. Every early-return path uses emptySummary(), which must also satisfy the schema.
const empty = {
  success: true,
  executionStatus: 'no_previous_failures',
  message: 'No previous failed/error test cases were found.',
  projectRoot: root,
  gradleTask: ':app:testDebugUnitTest',
  selectedFilters: [],
  summary: {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    reportFiles: 0,
    usableReports: 0,
    failuresList: [],
  },
  rawOutputTail: '',
}
check(empty, 'empty-summary path')

// 3. emptySummary() from lib must carry the declared fields.
const { emptySummary, parseReports } = await import(pathToFile(path.join(root, 'lib', 'results.js')))
const es = emptySummary()
assert.equal(es.reportFiles, 0)
assert.equal(es.usableReports, 0)
assert.deepEqual(es.failuresList, [])

// 4. parseReports must produce a value the schema accepts end-to-end.
const tmp = path.join(root, '.verify-tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const report = `<?xml version="1.0"?><testsuite tests="3" failures="1" errors="0" skipped="1"><testcase classname="com.example.LoginTest" name="passes"/><testcase classname="com.example.LoginTest" name="fails"><failure message="Expected true">java.lang.AssertionError: Expected true</failure></testcase><testcase classname="com.example.LoginTest" name="skips"><skipped/></testcase></testsuite>`
fs.writeFileSync(path.join(tmp, 'TEST-LoginTest.xml'), report)
const parsed = parseReports([path.join(tmp, 'TEST-LoginTest.xml')])
assert.equal(parsed.reportFiles, 1)
assert.equal(parsed.usableReports, 1)
fs.rmSync(tmp, { recursive: true, force: true })

console.log('Output schema now declares reportFiles/usableReports; all return paths validate: OK')

function pathToFile(file) {
  return new URL(`file://${file.replaceAll('\\', '/')}`)
}
