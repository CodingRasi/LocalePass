
<img width="900" height="600" alt="LocalePass_logo" src="https://github.com/user-attachments/assets/40010cca-f27c-4bf0-9177-6b7cdf3e32ee" />

# LocalePass

LocalePass is a CLI tool for checking localized web pages before release.

It helps you catch visual regressions, layout problems, and common localization mistakes across locales and viewports. You can run it locally while developing, or wire it into CI if you want repeatable checks on every change.

The project is open source and still evolving. The goal is straightforward: make localization QA easier to run, easier to understand, and easier to automate.

## What it does

LocalePass can:

- open real pages in a browser
- capture screenshots for each page, locale, and viewport
- compare current screenshots against saved baseline snapshots
- generate visual diffs when something changes
- report possible layout and localization issues
- export results as HTML, JSON, Markdown, and SARIF
- run locally or in CI

Current checks include:

- visual snapshot regression
- text overflow and clipping heuristics
- missing `html[lang]`
- possible untranslated strings compared to a baseline locale
- possible RTL-related issues

## What it is for

LocalePass is built for browser-accessible products such as:

- websites
- web apps
- dashboards
- signup and onboarding flows
- pricing and billing pages
- documentation sites
- admin panels
- localized marketing pages

It is **not** a native iOS or Android UI testing framework. Right now, it is focused on web surfaces.

## Install

```bash
npm install
npx playwright install chromium
npm run build
````

If you want to use the command directly from your terminal:

```bash
npm link
```

Then you can run:

```bash
localepass scan example.com
```

## Quick examples

Scan a public page:

```bash
localepass scan nasa.com
```

Scan a specific page:

```bash
localepass scan example.com/pricing
```

Scan a localized route pattern:

```bash
localepass scan "example.com/{locale}/pricing" --locales en,de,fr
```

Scan using a config file:

```bash
localepass scan --config localepass.config.json
```

## How it works

LocalePass has two main workflows.

### 1. Ad hoc scan

Use this when you want to quickly inspect a public page or route.

```bash
localepass scan lent.az
```

### 2. Baseline comparison

Use this when you want repeatable regression checks.

First create or refresh snapshots:

```bash
localepass scan --config localepass.config.json --update-snapshots --no-fail-on-issues
```

Then run future comparisons against those snapshots:

```bash
localepass scan --config localepass.config.json
```

## Reports

LocalePass writes reports to a report directory and snapshots to a snapshot directory.

Typical outputs include:

* `report.html`
* `summary.json`
* `summary.md`
* `summary.sarif.json`

The HTML report is meant for humans.
JSON and SARIF are there for automation and CI tooling.

## Demo

The repository includes a small demo site so you can try the full workflow locally.

Start the demo site from the repository root:

```bash
python3 -m http.server 3000
```

Then create baseline snapshots:

```bash
npm run test:demo:quick:update-snapshots
```

Then run the comparison:

```bash
npm run test:demo:quick
```

The quick demo uses a lighter setup so you can see the tool without waiting too long.

## Configuration

For repeated checks, use a config file.

Example:

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

## Useful CLI options

* `--config <path>` — use a config file
* `--update-snapshots` — replace baseline snapshots with current screenshots
* `--no-fail-on-issues` — exit successfully even if findings are reported
* `--open-report` — open the HTML report automatically after the scan
* `--terminal-report` — print a summary of findings directly in the terminal
* `--concurrency <n>` — control how many scan jobs run in parallel

## Authenticated scans

If your app requires login, you can provide a Playwright storage state file and reuse an authenticated browser session.

Typical flow:

* log in once with Playwright
* save `storageState` to a file
* point LocalePass to that file in your config

## GitHub Action

LocalePass can also run in GitHub Actions.

Example workflow:

```yaml
name: LocalePass

on:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          config: localepass.config.json
          format: html,json,markdown,sarif
          snapshot-dir: .localepass/snapshots
          fail-on-issues: 'true'
```

## Docker

Build:

```bash
docker build -t localepass:1.0 .
```

Run:

```bash
docker run --rm -v "$PWD":/work -w /work localepass:1.0 scan --config localepass.config.json
```

## Project status

LocalePass is usable today, but it is still growing.

Some parts are already solid, especially screenshot capture, baseline comparison, and report generation. Some heuristics still need tuning, especially on noisy public websites with dynamic content, carousels, tickers, ads, or frequently changing homepages.

So if you use the tool and run into false positives, rough edges, or confusing output, please open an issue. That kind of feedback is exactly what makes the project better.

## Contributing

Contributions are welcome.

Good areas to improve:

* better issue precision
* fewer false positives
* better report UX
* stronger terminal output
* more stable handling of dynamic pages
* better fixture coverage and tests
* docs and real-world examples

A good place to start is simple:

1. run the demo
2. try the tool on a real site
3. find something noisy, confusing, or broken
4. open an issue or send a pull request

## Philosophy

LocalePass is meant to be practical.

Not a giant platform.
Not a black box.
Just a tool that helps developers catch broken localized UI before users do.

## License
MIT
