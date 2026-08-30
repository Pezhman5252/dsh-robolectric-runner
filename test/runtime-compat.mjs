// End-to-end compatibility test against the REAL runtime dsh-tools (0.1.1-rc.2):
// the plugin builds its tool with its own dsh-tools (0.0.1-rc.5), but the DSH
// runtime validates the output schema and returned value with ITS OWN copy
// (validateJsonSchemaValue, path "value"). This test reproduces exactly that
// boundary: tool built with the plugin copy, value validated by the runtime copy.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 1. Load the RUNTIME's dsh-tools (the copy the running DSH web app uses).
const runtimeTools = await import('file:///C:/Users/Pezhman/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
console.log('runtime dsh-tools version:', (await import('file:///C:/Users/Pezhman/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/package.json', { with: { type: 'json' } })).default.version)

// 2. Load the plugin (it resolves @deepseek-ai/dsh-tools from ITS OWN node_modules).
const { apply } = await import(pathToFile(path.join(root, 'lib', 'index.js')))
let captured
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  tools: { register(def) { captured = def } },
}
apply(ctx)
assert.ok(captured, 'run_robolectric must register')
assert.equal(captured.name, 'run_robolectric')

// 3. The runtime asserts the schema is within the supported subset when registering.
assert.doesNotThrow(() => runtimeTools.assertSupportedJsonSchema(captured.output.schema), 'schema must pass runtime assertSupportedJsonSchema')

// 4. Validate realistic return values with the RUNTIME validator, exactly as
//    ToolRuntime#present does: validateJsonSchemaValue(schema, value, "value").
const validate = (value, label) => {
  const violations = runtimeTools.validateJsonSchemaValue(captured.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${label}: ${violations.join('; ')}`)
}

const successValue = {
  success: true,
  executionStatus: 'passed',
  message: 'Gradle completed successfully.',
  projectRoot: 'C:/proj',
  gradleTask: ':app:testDebugUnitTest',
  selectedFilters: [],
  summary: {
    total: 3, passed: 2, failed: 1, skipped: 0,
    reportFiles: 5, usableReports: 2,
    failuresList: [{ testClass: 'com.example.LoginTest', testName: 'fails', error: 'Expected true' }],
  },
  rawOutputTail: 'BUILD SUCCESSFUL',
}
validate(successValue, 'success path')

validate({
  success: true,
  executionStatus: 'no_previous_failures',
  message: 'No previous failures.',
  projectRoot: 'C:/proj',
  gradleTask: ':app:testDebugUnitTest',
  selectedFilters: [],
  summary: { total: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 0, usableReports: 0, failuresList: [] },
  rawOutputTail: '',
}, 'empty summary path')

// 5. Negative check: the OLD bug would have produced exactly this violation.
const broken = structuredClone(successValue)
delete broken.summary.reportFiles
delete broken.summary.usableReports
const oldViolations = runtimeTools.validateJsonSchemaValue(captured.output.schema, broken, 'value')
assert.ok(oldViolations.length > 0, 'schema must still reject a summary missing the declared fields')
console.log('negative check OK (missing fields still rejected):', oldViolations[0])

console.log('RUNTIME COMPATIBILITY: OK — schema passes runtime assertSupportedJsonSchema and all return paths validate with the runtime validator')

function pathToFile(file) {
  return new URL(`file://${file.replaceAll('\\', '/')}`)
}
