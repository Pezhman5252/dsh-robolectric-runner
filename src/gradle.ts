import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

const MAX_CAPTURE_BYTES = 256 * 1024

function limitedAppend(parts: Buffer[], currentBytes: { value: number }, chunk: Buffer): void {
  if (currentBytes.value >= MAX_CAPTURE_BYTES) return
  const remaining = MAX_CAPTURE_BYTES - currentBytes.value
  const slice = chunk.subarray(0, remaining)
  parts.push(slice)
  currentBytes.value += slice.byteLength
}

async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('close', () => resolve())
      killer.once('error', () => resolve())
    })
  } else {
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500))
    if (!child.killed) {
      try { child.kill('SIGKILL') } catch {}
    }
  }
}

export async function runGradle(
  projectRoot: string,
  gradleArgs: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProcessResult> {
  const windows = process.platform === 'win32'
  const child = windows
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['gradlew.bat', ...gradleArgs].join(' ')], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn('./gradlew', gradleArgs, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const stdoutBytes = { value: 0 }
  const stderrBytes = { value: 0 }
  child.stdout?.on('data', (chunk: Buffer) => limitedAppend(stdout, stdoutBytes, Buffer.from(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => limitedAppend(stderr, stderrBytes, Buffer.from(chunk)))

  let timedOut = false
  let aborted = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined

  const result = await new Promise<ProcessResult>((resolve) => {
    const finish = (value: ProcessResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      resolve(value)
    }

    timer = setTimeout(() => {
      timedOut = true
      void killProcessTree(child).finally(() => {
        finish({
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          aborted,
        })
      })
    }, timeoutMs)

    abortHandler = () => {
      aborted = true
      void killProcessTree(child).finally(() => {
        finish({
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          aborted,
        })
      })
    }
    if (signal) {
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })
    }

    child.once('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}\n${String(error)}`.trim(),
        timedOut,
        aborted,
      })
    })

    child.once('close', (code, closeSignal) => {
      finish({
        exitCode: code,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        aborted,
      })
    })
  })

  return result
}

function readBuildScript(projectRoot: string): string {
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const file = join(projectRoot, name)
    try {
      return readFileSync(file, 'utf8')
    } catch {}
  }
  return ''
}

function looksLikeAndroidModule(projectRoot: string): boolean {
  const script = readBuildScript(projectRoot)
  return /com\.android\.(application|library)/.test(script) || /android\s*\{/.test(script)
}

function gradleProjectPathToDirectory(projectRoot: string, modulePath: string): string {
  const relative = modulePath.slice(1).split(':').filter(Boolean).join('/')
  return join(projectRoot, relative)
}

function includedModules(projectRoot: string): string[] {
  const settings = ['settings.gradle.kts', 'settings.gradle']
    .map((name) => join(projectRoot, name))
    .find((file) => existsSync(file))
  if (!settings) return []
  let text = ''
  try { text = readFileSync(settings, 'utf8') } catch { return [] }
  const result: string[] = []
  const regex = /include\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const body = match[1] ?? ''
    for (const token of body.matchAll(/['"](:[A-Za-z0-9_.-]+(?:\:[A-Za-z0-9_.-]+)*)['"]/g)) {
      const value = token[1]
      if (value) result.push(value)
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const single = /^\s*include\s+['"](:[A-Za-z0-9_.-]+(?:\:[A-Za-z0-9_.-]+)*)['"]/.exec(line)
    if (single?.[1]) result.push(single[1])
  }
  return [...new Set(result)]
}

export function detectDefaultModule(projectRoot: string): string {
  if (looksLikeAndroidModule(projectRoot)) return ''
  const candidates = includedModules(projectRoot)
  const androidCandidates = candidates.filter((module) => {
    const dir = gradleProjectPathToDirectory(projectRoot, module)
    return existsSync(dir) && looksLikeAndroidModule(dir)
  })
  if (androidCandidates.includes(':app')) return ':app'
  if (androidCandidates.length === 1) return androidCandidates[0]!

  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(projectRoot, entry.name)
      if (looksLikeAndroidModule(dir)) return `:${entry.name}`
    }
  } catch {}

  return ''
}

export function normalizeModule(projectRoot: string, value: string | undefined): string {
  const raw = value?.trim() || detectDefaultModule(projectRoot)
  if (!raw) return ''
  const candidate = raw.startsWith(':') ? raw : `:${raw}`
  if (!/^:[A-Za-z0-9_.-]+(?:\:[A-Za-z0-9_.-]+)*$/.test(candidate)) {
    throw new Error('Invalid module. Use a Gradle project path such as "app" or ":feature:login".')
  }
  const dir = gradleProjectPathToDirectory(projectRoot, candidate)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Gradle module ${candidate} does not exist in the session workspace.`)
  }
  return candidate
}

export function normalizeVariant(value: string | undefined): string {
  const raw = value?.trim() || 'Debug'
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
    throw new Error('Invalid variant. Use a Gradle variant such as "Debug", "Release", or "BenchmarkDebug".')
  }
  return raw[0]!.toUpperCase() + raw.slice(1)
}

export function normalizeFilter(value: string | undefined): string | undefined {
  const filter = value?.trim()
  if (!filter) return undefined
  if (filter.length > 300 || /[\r\n\s'"`&|;<>()[\]{}]/.test(filter)) {
    throw new Error('Invalid testFilter. Use a single Gradle --tests selector such as "com.example.LoginTest" or "com.example.LoginTest.login".')
  }
  if (!/^[A-Za-z0-9_.$*?:\-]+$/.test(filter)) {
    throw new Error('Invalid testFilter. Unsupported characters were found.')
  }
  return filter
}

export function buildTask(modulePath: string, variant: string): string {
  return `${modulePath}:test${variant}UnitTest`
}

export function wrapperExists(projectRoot: string): boolean {
  return process.platform === 'win32'
    ? existsSync(join(projectRoot, 'gradlew.bat'))
    : existsSync(join(projectRoot, 'gradlew'))
}
