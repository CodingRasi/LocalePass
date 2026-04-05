## 1.0.1

- ad hoc scans now auto-discover available locales on the target site instead of defaulting to English only
- `localepass scan tesla.com` and similar commands now scan every locale the site exposes when they can be detected
- version bump to 1.0.1

# Changelog

## 0.9.0

- added visual snapshot baselines with update and compare flow
- added diff image generation through ImageMagick
- added SARIF output for CI/code scanning ingestion
- added GitHub Actions step-summary output
- added browser/runtime hardening with system Chromium fallback
- expanded config schema with browser, snapshot, and selector wait options
- added demo config, release workflow, and improved action inputs
- upgraded reports to include snapshot state and diff artifacts
