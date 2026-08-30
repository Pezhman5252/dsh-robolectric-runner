# dsh-robolectric-runner

[![npm version](https://img.shields.io/npm/v/dsh-robolectric-runner)](https://www.npmjs.com/package/dsh-robolectric-runner)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) bundle that registers the `run_robolectric` tool for executing Android local JVM unit tests — including Robolectric tests — directly from the DSH agent, with structured Gradle XML test-result parsing.

## Installation

### 1. Install the npm package as a DSH profile dependency

```powershell
npm i dsh-robolectric-runner
```

### 2. Register the bundle into your DSH profile

```powershell
dsh plugin --profile web add dsh-robolectric-runner
```

Verify the plugin is recognized:

```powershell
dsh --profile web --dump-config
```

### 3. Start the web runner

```powershell
npx @deepseek-ai/dsh web --no-open
```

The plugin is now available as the `run_robolectric` tool in the DSH agent's tool set.

---

## Tool semantics

`run_robolectric` runs Android local JVM tests. It is **not** an Android instrumentation/device test runner.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `module` | `string` | auto-detected | Optional Gradle module path, e.g. `"app"` or `":feature:login"`. If omitted, the plugin checks whether the root project itself is an Android project, then scans modules declared in `settings.gradle(.kts)` (preferring `:app`), and finally inspects immediate child directories. |
| `variant` | `string` | `"Debug"` | Build variant, e.g. `"Debug"`, `"Release"`, `"BenchmarkDebug"`. |
| `testFilter` | `string` | — | A single Gradle `--tests` selector, e.g. `"com.example.LoginTest"` or `"com.example.LoginTest.login"`. Shell metacharacters and spaces are rejected. |
| `rerunFailed` | `boolean` | `false` | When `true`, reads the previous XML test reports for the same task and reruns only the failed/error test cases. Cannot be combined with `testFilter`. |
| `timeoutMs` | `number` | `300000` | Maximum Gradle execution time in milliseconds (1000 – 900000). |

### Output

The tool returns a structured result with:

- **Test counts** — total, passed, failed, skipped
- **Failure details** — class name, method name, and error message for each failed test (up to 100)
- **Report diagnostics** — number of XML report files found and how many were parseable
- **Raw output tail** — the last 6000 characters of the Gradle console output for debugging

---

## Design goals

- Uses the DSH bundle manifest (`dsh.bundle.patch`).
- Registers exactly one Cordis plugin with a matching id/name.
- Uses the active DSH session workspace (`agent.session.header.cwd`).
- Does **not** accept an arbitrary shell command from the model.
- Validates module, variant and test filters before execution.
- Uses the Gradle wrapper from the active project.
- Uses direct `spawn()` with fixed argv on POSIX and a fixed `cmd.exe /c` wrapper on Windows. Model input is restricted to a conservative allowlist, so shell metacharacters are rejected rather than interpreted.
- Kills the full Windows process tree with `taskkill /T /F` on timeout/cancellation.
- Uses Gradle XML test reports as the authoritative test-result source.
- Ignores stale XML reports after a fresh run by requiring current report modification times.
- Implements `rerunFailed` from the previous XML reports and passes the specific failing tests through repeated Gradle `--tests` selectors.
- Uses `--rerun-tasks` only to force the requested Gradle task to execute; it is not used as a substitute for `rerunFailed` filtering.
- Marks the tool non-concurrency-safe by design through the tool runtime's normal serialization defaults; the plugin does not advertise concurrent safety.

---

## DSH dependency model

The plugin declares `@deepseek-ai/dsh-tools@0.0.1-rc.5` as both a **runtime dependency** and a **dev dependency**, and `@deepseek-ai/cordis` as an **optional peer dependency**.

**Why a pinned runtime dependency?**  
Out-of-tree DSH bundles are loaded from their installed package location, so Node.js must be able to resolve `@deepseek-ai/dsh-tools` from the plugin package itself. The version `0.0.1-rc.5` is pinned because the npm `latest` tag for `@deepseek-ai/dsh-tools` currently points to an older version (`0.0.1-rc.1`) with a broken peer graph; this pin is the documented community workaround.

**Why an optional peer?**  
`@deepseek-ai/cordis` is supplied by the DSH runtime profile. Making it an optional peer avoids packaging a second private copy of Cordis and prevents symbol-identity conflicts.

---

## Runtime compatibility

The runtime API surface intentionally stays on the stable `defineTool` / `ctx.tools.register` contract and avoids newer optional `ToolDefinition` features. The profile's installed `@deepseek-ai/dsh-tools` must be compatible with that stable surface — the plugin has been verified against DSH runtime `dsh-tools@0.1.1-rc.2`.

---

## Development & local verification

```powershell
# Clone or download the source
cd dsh-robolectric-runner

# Install dependencies
npm install

# Build TypeScript source
npm run build

# Run the built-in verification (manifest + XML parser + schema validation)
npm run verify
```

Expected output:

```text
Plugin manifest and XML parser verification: OK
```

### Running the schema validation tests

Additional verification scripts are available in `test/`:

```powershell
# Regression test: output schema declares all fields
node test/schema-verify.mjs

# End-to-end test against the actual DSH runtime dsh-tools version
node test/runtime-compat.mjs
```

---

## License

[MIT](LICENSE)