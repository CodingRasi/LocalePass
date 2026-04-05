<img width="900" height="600" alt="LocalePass_logo" src="https://github.com/user-attachments/assets/40010cca-f27c-4bf0-9177-6b7cdf3e32ee" />

# LocalePass v1.0.2.

Catch localization, visual regressions, and UI breakage before release.

LocalePass is a GitHub-first localization QA tool for web apps. It ships as a CLI and GitHub Action so teams can run checks in CI before they push broken localized UI live.

## What this repo is now

This version is no longer just a scanner prototype. It includes:

- localization QA heuristics
- visual snapshot regression checks
- HTML, JSON, Markdown, and SARIF outputs
- snapshot update flow for PR and release pipelines
- authenticated scans via Playwright `storageState`
- GitHub Action wrapper and CI/release workflows
- Docker support
- JSON Schema for editor validation

## Core capabilities

### Localization QA
- untranslated string detection against a baseline locale
- text overflow and clipping detection
- missing `html[lang]` detection
- RTL suspicion detection

### Visual regression
- screenshot capture per page, locale, and viewport
- baseline snapshot comparison using ImageMagick
- diff image generation
- configurable mismatch thresholds
- snapshot refresh mode

### CI outputs
- HTML report for humans
- JSON summary for automation
- Markdown summary for PR comments or Slack
- SARIF output for code-scanning style ingestion
- GitHub step summary output when running in Actions

## Quick start

## Fastest way to see what it does

Start the demo site:

```bash
python3 -m http.server 3000
```

In another terminal, run the quick baseline once:

```bash
npm run build
npm run test:demo:quick:update-snapshots
```

Then run the quick comparison:

```bash
npm run test:demo:quick
```

This quick mode is the best first impression because it:
- uses one viewport instead of two
- opens the HTML report automatically
- prints the top issues and suggested fixes directly in the terminal
- still generates screenshots, diffs, and machine-readable artifacts

The full demo is still available:

```bash
npm run test:demo:update-snapshots
npm run test:demo
```


```bash
npm install
npx playwright install --with-deps chromium
npm run build
node dist/packages/cli/src/index.js scan --config localepass.config.json
```

Generated artifacts land in:

```bash
reports/localepass/
```

## CLI usage

```bash
localepass scan --config localepass.config.json --format html,json,markdown,sarif
```

Useful options:

- `--config <path>`: config file path
- `--output-dir <path>`: override output directory
- `--snapshot-dir <path>`: override snapshot directory
- `--format <list>`: comma-separated `html,json,markdown,sarif`
- `--clean`: remove the output directory before scanning
- `--update-snapshots`: replace the baseline snapshots with the current screenshots
- `--no-fail-on-issues`: exit with code 0 even if issues are found
- `--open-report`: open the HTML report automatically
- `--terminal-report`: print the top issues and fix hints directly in the terminal
- `--concurrency <n>`: run locale scans in parallel per page and viewport

## Recommended pipeline

### 1. Establish baselines

```bash
localepass scan --config localepass.config.json --update-snapshots --no-fail-on-issues
```

### 2. Compare future runs against snapshots

```bash
localepass scan --config localepass.config.json
```

## Config example

```json
{
  "$schema": "./localepass.schema.json",
  "baseUrl": "https://example.com",
  "baselineLocale": "en",
  "report": {
    "includeHtml": true,
    "includeJson": true,
    "includeMarkdown": true,
    "includeSarif": true
  },
  "visualDiff": {
    "enabled": true,
    "snapshotDir": ".localepass/snapshots",
    "allowedMismatchPixels": 100,
    "allowedMismatchRatio": 0.001
  }
}
```

## Demo locally

The repo includes a static demo site and matching config.

Start a local file server from the repo root:

```bash
python3 -m http.server 3000
```

Then create snapshots:

```bash
npm run test:demo:update-snapshots
```

Then run a comparison scan:

```bash
npm run test:demo
```

## GitHub Action

```yaml
name: LocalePass

on:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./. 
        with:
          config: localepass.config.json
          format: html,json,markdown,sarif
          snapshot-dir: .localepass/snapshots
          fail-on-issues: 'true'
```

To refresh snapshots on demand:

```yaml
- uses: ./. 
  with:
    config: localepass.config.json
    update-snapshots: 'true'
    fail-on-issues: 'false'
```

## Docker

Build:

```bash
docker build -t localepass:0.9 .
```

Run:

```bash
docker run --rm \
  -v "$PWD":/work \
  -w /work \
  localepass:0.9 \
  scan --config localepass.config.json
```

## Authenticated scans

Create Playwright storage state once and point the config to it.

Example concept:

```ts
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://example.com/login');
// perform login
await page.context().storageState({ path: '.auth/localepass-storage-state.json' });
await browser.close();
```

## What still belongs in the paid layer later

This repo is now solid for open-source distribution, but the monetizable layer later should be:

- hosted run history
- PR comments and triage workflow
- Slack/Jira sync
- multi-project workspaces
- flaky-diff suppression and approvals
- branch preview auto-discovery
- team roles and audit trail

## Publishing checklist

1. Replace GitHub URLs in `package.json`
2. Add your npm scope if needed
3. Create `NPM_TOKEN` in GitHub Actions secrets
4. Run `npm pack`
5. Smoke-test the tarball in a clean directory
6. Publish with `npm publish --access public`

## License

MIT
