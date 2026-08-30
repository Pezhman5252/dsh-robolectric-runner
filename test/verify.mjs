import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
const lib = path.join(root, 'lib', 'index.js')

assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.main, 'lib/index.js')
assert.ok(fs.existsSync(lib), 'lib/index.js must exist; run npm run build first')
assert.ok(patch.includes('id: dsh-robolectric-runner'))
assert.ok(patch.includes('name: dsh-robolectric-runner'))
assert.equal(pkg.dependencies?.['@deepseek-ai/dsh-tools'], '0.0.1-rc.5')
assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/cordis']?.optional, true)
assert.ok(pkg.devDependencies?.['@deepseek-ai/dsh-tools'])

const { parseReports } = await import(pathToFile(path.join(root, 'lib', 'results.js')))
const tmp = path.join(root, '.verify-tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const report = `<?xml version="1.0"?><testsuite tests="3" failures="1" errors="0" skipped="1"><testcase classname="com.example.LoginTest" name="passes"/><testcase classname="com.example.LoginTest" name="fails"><failure message="Expected true">java.lang.AssertionError: Expected true</failure></testcase><testcase classname="com.example.LoginTest" name="skips"><skipped/></testcase></testsuite>`
fs.writeFileSync(path.join(tmp, 'TEST-LoginTest.xml'), report)
const parsed = parseReports([path.join(tmp, 'TEST-LoginTest.xml')])
assert.deepEqual({ total: parsed.total, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped }, { total: 3, passed: 1, failed: 1, skipped: 1 })
assert.equal(parsed.failuresList[0]?.testClass, 'com.example.LoginTest')
assert.equal(parsed.failuresList[0]?.testName, 'fails')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('Plugin manifest and XML parser verification: OK')

function pathToFile(file) {
  return new URL(`file://${file.replaceAll('\\', '/')}`)
}
