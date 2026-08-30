# dsh-robolectric-runner 1.3.0

A DeepSeek Harness bundle that registers `run_robolectric` for Android local JVM tests, including Robolectric tests when the project is configured for Robolectric.

## Design goals

- Uses the DSH bundle manifest (`dsh.bundle.patch`).
- Registers exactly one Cordis plugin with a matching id/name.
- Uses the active DSH session workspace (`agent.session.header.cwd`).
- Does not accept an arbitrary shell command from the model.
- Validates module, variant and test filters before execution.
- Uses the Gradle wrapper from the active project.
- Uses direct `spawn()` with fixed argv on POSIX and a fixed `cmd.exe /c` wrapper on Windows. Model input is restricted to a conservative allowlist, so shell metacharacters are rejected rather than interpreted.
- Kills the full Windows process tree with `taskkill /T /F` on timeout/cancellation.
- Uses Gradle XML test reports as the authoritative test-result source.
- Ignores stale XML reports after a fresh run by requiring current report modification times.
- Implements `rerunFailed` from the previous XML reports and passes the specific failing tests through repeated Gradle `--tests` selectors.
- Uses `--rerun-tasks` only to force the requested Gradle task to execute; it is not used as a substitute for `rerunFailed` filtering.
- Marks the tool non-concurrency-safe by design through the tool runtime's normal serialization defaults; the plugin does not advertise concurrent safety.
- Keeps the DSH core packages as optional peers so the profile/runtime supplies the single installed copy. This avoids packaging a second private copy of `dsh-tools`, which can cause symbol-identity failures in Harness profiles.

## Important npm/DSH packaging note

The npm registry currently exposes a stale `latest` tag for `@deepseek-ai/dsh-tools` at `0.0.1-rc.1`; DeepSeek Harness maintainers/users have documented that line as broken for external installs and recommend `0.0.1-rc.5` as an installable workaround. The plugin therefore uses `0.0.1-rc.5` only as a **development/build dependency**. At runtime the DSH profile should provide its own installed `dsh-tools` copy through the optional peer.

Do not convert `@deepseek-ai/dsh-tools` into a normal runtime dependency unless you intentionally want a second copy of the Harness tool package in the profile.

## Local verification

```powershell
cd C:\path\to\dsh-robolectric-runner-v1.3.0
npm install
npm run build
npm run verify
```

Expected verification result:

```text
Plugin manifest and XML parser verification: OK
```

## Install into the DSH web profile

```powershell
dsh plugin --profile web add C:\path\to\dsh-robolectric-runner-v1.3.0
```

Then inspect the composed profile:

```powershell
dsh --profile web --dump-config
```

Start the web runner:

```powershell
npx @deepseek-ai/dsh web --no-open
```

The plugin should no longer emit the previous `declares no dsh.bundle` warning.

## Tool semantics

`run_robolectric` runs Android local JVM tests. It is not an Android instrumentation/device test runner.

Parameters:

- `module`: optional module path such as `app` or `:feature:login`.
- `variant`: optional build variant; defaults to `Debug`.
- `testFilter`: optional single Gradle `--tests` selector.
- `rerunFailed`: reruns only failed/error test cases found in the previous XML reports for the same task. It cannot be combined with `testFilter`.
- `timeoutMs`: 1,000 to 900,000 ms, default 300,000 ms.

If no module is supplied, the plugin first checks whether the root project itself looks like an Android project, then checks modules declared by `settings.gradle(.kts)`, preferring `:app`, and finally checks immediate child directories.

## Runtime compatibility

The runtime API surface intentionally stays on the stable `defineTool`/`ctx.tools` contract and avoids newer optional ToolDefinition features. The profile's installed `@deepseek-ai/dsh-tools` must be compatible with that stable surface.

## Runtime dependency note

`@deepseek-ai/dsh-tools@0.0.1-rc.5` is declared as a runtime dependency, not only a dev/peer dependency. This is intentional: out-of-tree DSH bundles are loaded from their installed package location, so Node must be able to resolve `@deepseek-ai/dsh-tools` from the plugin package itself. `0.0.1-rc.5` is pinned because the npm `latest` tag currently points to an older broken peer graph; this pin is the documented community workaround.
