# API Capture Harness Fork

This repository is the source runtime used by API Capture Assistant's native Harness launcher.

## Upstream baseline

- Upstream repository: <https://github.com/deepseek-ai/deepseek-harness.git>
- Upstream remote: `upstream`
- Baseline commit: `47f943859bef60e4160492346772ded9b24f765a`
- Integration branch: `codex/mvp0-companion-integration`

## Local ownership

The fork owns the Windows and Apple Silicon macOS Harness runtimes, native Web Prompt draft bridge, Cordis composition, release metadata, and runtime lifecycle. The Chrome extension owns product and developer Prompt construction. API Capture Assistant owns the native launcher and portable release assembly in its separate repository.

Local changes prefer public Cordis and SDK extension points. Core Harness packages change only when the published extension points cannot enforce a required runtime behavior.

## Build

```powershell
corepack pnpm install
corepack pnpm run build:api-capture-web
```

The final command writes the host runtime under `dist/api-capture-harness-win-x64/` on Windows or `dist/api-capture-harness-darwin-arm64/` on Apple Silicon macOS. It records the upstream commit, fork commit, dirty state, Node version, bridge protocol, and artifact checksums in `harness-build.json`.

The API Capture Assistant repository pins an accepted build through `harness.lock.json`. Do not update the baseline or regenerate a release without running the Prompt draft bridge test and portable native Web smoke test.
