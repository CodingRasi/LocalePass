#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { chromium } from 'playwright';
import { mkdir, readFile, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

interface LocaleSpec {
  name: string;
  code: string;
  url?: string;
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
}

interface PageSpec {
  name: string;
  url: string;
  waitFor?: number;
  waitForSelector?: string;
  selectorsToIgnore?: string[];
  textPatternsToIgnore?: string[];
  snapshotKey?: string;
}

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

interface ScanConfig {
  baseUrl?: string;
  baselineLocale: string;
  outputDir?: string;
  cleanOutputDir?: boolean;
  pages: PageSpec[];
  locales: LocaleSpec[];
  viewports?: ViewportSpec[];
  auth?: {
    storageStatePath?: string;
  };
  browser?: {
    headless?: boolean;
    timeoutMs?: number;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    concurrency?: number;
  };
  report?: {
    title?: string;
    includeHtml?: boolean;
    includeJson?: boolean;
    includeMarkdown?: boolean;
    includeSarif?: boolean;
    autoOpen?: boolean;
    terminalSummary?: boolean;
    maxIssuesInTerminal?: number;
    supportMessage?: string;
  };
  ignore?: {
    selectors?: string[];
    textPatterns?: string[];
  };
  visualDiff?: {
    enabled?: boolean;
    snapshotDir?: string;
    diffDir?: string;
    compareAgainstSnapshots?: boolean;
    generateDiffImages?: boolean;
    failOnMissingSnapshots?: boolean;
    allowedMismatchPixels?: number;
    allowedMismatchRatio?: number;
    fullPage?: boolean;
  };
  thresholds?: {
    untranslatedOverlapRatio?: number;
    untranslatedCorpusMatchRatio?: number;
    overflowPixels?: number;
    maxTextExpansionRatio?: number;
    minTextLengthForTranslationCheck?: number;
  };
}

type IssueType =
  | 'text-overflow'
  | 'text-clipped'
  | 'untranslated-text'
  | 'missing-lang-attribute'
  | 'rtl-suspected'
  | 'snapshot-diff'
  | 'snapshot-missing'
  | 'navigation-error'
  | 'heuristic-warning';

interface DomIssue {
  type: IssueType;
  severity: 'error' | 'warning' | 'info';
  message: string;
  selector: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  ratio?: number;
  details?: Record<string, string | number | boolean | null>;
}

interface VisualDiffResult {
  snapshotPath?: string;
  diffImagePath?: string;
  metric?: string;
  mismatchPixels?: number;
  mismatchRatio?: number;
  status: 'matched' | 'different' | 'missing' | 'updated' | 'disabled';
}

interface LocalePageResult {
  pageName: string;
  locale: string;
  viewport: string;
  screenshotPath: string;
  issues: DomIssue[];
  textCorpus: string[];
  textStats: {
    nodeCount: number;
    avgLength: number;
    totalLength: number;
  };
  scanUrl: string;
  snapshotKey: string;
  visualDiff: VisualDiffResult;
}

interface Summary {
  generatedAt: string;
  toolVersion: string;
  reportTitle: string;
  totalScans: number;
  totalIssues: number;
  issueCountsByType: Record<string, number>;
  issueCountsBySeverity: Record<string, number>;
  formats: string[];
  snapshotStats: {
    matched: number;
    different: number;
    missing: number;
    updated: number;
    disabled: number;
  };
  results: LocalePageResult[];
}

interface ScanCommandOptions {
  config?: string;
  url?: string;
  name?: string;
  locales?: string;
  baselineLocale?: string;
  viewport?: string;
  outputDir?: string;
  format: string;
  failOnIssues: boolean;
  clean?: boolean;
  updateSnapshots?: boolean;
  snapshotDir?: string;
  openReport?: boolean;
  terminalReport?: boolean;
  concurrency?: string;
}

interface EvaluateArgs {
  selectorsToIgnore: string[];
  textPatternsToIgnore: string[];
  overflowPixels: number;
  baselineTexts: string[];
  untranslatedOverlapRatio: number;
  untranslatedCorpusMatchRatio: number;
  maxTextExpansionRatio: number;
  minTextLengthForTranslationCheck: number;
}

const TOOL_VERSION = '1.0.0';
const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { name: 'desktop', width: 1440, height: 1024 },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2 }
];

const program = new Command();
program.name('localepass').description('Catch localization and UI breakage before release.').version(TOOL_VERSION);

program
  .command('init')
  .description('Create a sample localepass.config.json in the current directory')
  .action(async () => {
    const configPath = resolve(process.cwd(), 'localepass.config.json');
    await writeFile(configPath, JSON.stringify(sampleConfig(), null, 2), 'utf8');
    console.log(chalk.green(`Created ${configPath}`));
  });

program
  .command('scan [target]')
  .description('Run a localization UI scan. Example: localepass scan nasa.com')
  .option('-c, --config <path>', 'Config file path')
  .option('--url <url>', 'Scan a single URL, domain, or a URL pattern like example.com/{locale}/pricing')
  .option('--name <name>', 'Page name for ad hoc scans', 'page')
  .option('--locales <codes>', 'Comma-separated locale codes for ad hoc scans', 'en')
  .option('--baseline-locale <code>', 'Baseline locale for translation comparisons', 'en')
  .option('--viewport <preset>', 'Viewport preset for ad hoc scans: desktop,mobile', 'desktop')
  .option('-o, --output-dir <path>', 'Override output directory')
  .option('--snapshot-dir <path>', 'Override snapshot directory')
  .option('--format <list>', 'Comma-separated output formats: html,json,markdown,sarif', 'html,json,markdown,sarif')
  .option('--fail-on-issues', 'Exit non-zero when issues are found', true)
  .option('--no-fail-on-issues', 'Exit zero even if issues are found')
  .option('--clean', 'Delete output directory before the run')
  .option('--update-snapshots', 'Write current screenshots into the snapshot directory')
  .option('--open-report', 'Open the HTML report automatically when finished')
  .option('--terminal-report', 'Print a user-friendly issue summary in the terminal')
  .option('--concurrency <n>', 'How many locale scans to run in parallel per page/viewport')
  .action(async (target: string | undefined, options: ScanCommandOptions) => {
    const formats = parseFormats(options.format);
    const isAdhoc = Boolean(target || options.url);
    const config = isAdhoc
      ? buildAdhocConfig(target ?? options.url!, options, formats)
      : await loadConfig(options.config ?? 'localepass.config.json', options.outputDir, options.snapshotDir, formats, options.clean);
    if (options.openReport || isAdhoc) config.report = { ...config.report, autoOpen: true };
    if (options.terminalReport || isAdhoc) config.report = { ...config.report, terminalSummary: true };
    if (options.concurrency) config.browser = { ...config.browser, concurrency: Math.max(1, Number(options.concurrency) || 1) };
    let updateSnapshots = Boolean(options.updateSnapshots);
    if (isAdhoc && !updateSnapshots) {
      const hasSnapshots = await directoryHasFiles(config.visualDiff?.snapshotDir);
      if (!hasSnapshots) {
        updateSnapshots = true;
        console.log(chalk.gray(`No snapshots found for ${config.report?.title ?? 'this target'}. Creating a fresh baseline first.`));
      }
    }
    const summary = await runScan(config, formats, updateSnapshots);
    const outputs = [
      config.report?.includeHtml ? join(config.outputDir!, 'report.html') : null,
      config.report?.includeJson ? join(config.outputDir!, 'summary.json') : null,
      config.report?.includeMarkdown ? join(config.outputDir!, 'summary.md') : null,
      config.report?.includeSarif ? join(config.outputDir!, 'summary.sarif.json') : null
    ].filter(Boolean);

    console.log(chalk.green(`\nScan finished: ${summary.totalScans} runs, ${summary.totalIssues} issues found.`));
    console.log(
      chalk.gray(
        `Snapshot stats: matched=${summary.snapshotStats.matched} different=${summary.snapshotStats.different} missing=${summary.snapshotStats.missing} updated=${summary.snapshotStats.updated}`
      )
    );
    for (const output of outputs) {
      console.log(chalk.cyan(`- ${relative(process.cwd(), output!)}`));
    }
    if (config.report?.terminalSummary) {
      printTerminalSummary(summary, config);
    }
    if (config.report?.autoOpen && config.report?.includeHtml) {
      await openReport(join(config.outputDir!, 'report.html'));
    }
    if (summary.totalIssues > 0 && options.failOnIssues) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

function parseFormats(input: string): Array<'html' | 'json' | 'markdown' | 'sarif'> {
  const values = input
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set(['html', 'json', 'markdown', 'md', 'sarif']);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(`Unsupported format: ${value}. Allowed: html,json,markdown,sarif`);
    }
  }
  const normalized = Array.from(new Set(values.map((value) => (value === 'md' ? 'markdown' : value)))) as Array<
    'html' | 'json' | 'markdown' | 'sarif'
  >;
  return normalized.length ? normalized : ['html', 'json', 'markdown', 'sarif'];
}


function buildAdhocConfig(
  targetUrl: string,
  options: ScanCommandOptions,
  formats: Array<'html' | 'json' | 'markdown' | 'sarif'>
): ScanConfig {
  const localeCodes = parseLocaleCodes(options.locales ?? 'en');
  const normalizedTargetUrl = normalizeTargetUrl(targetUrl, localeCodes[0] ?? 'en');
  const baselineLocale = options.baselineLocale ?? localeCodes[0] ?? 'en';
  const locales: LocaleSpec[] = localeCodes.map((code) => ({ name: code, code }));
  const reportName = sanitizeName(options.name ?? inferNameFromUrl(normalizedTargetUrl));
  const viewport = options.viewport === 'mobile'
    ? [{ name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2 }]
    : [{ name: 'desktop', width: 1440, height: 1024 }];

  return {
    baselineLocale,
    pages: [{ name: reportName, url: normalizedTargetUrl }],
    locales,
    viewports: viewport,
    outputDir: options.outputDir ?? `reports/${reportName}`,
    cleanOutputDir: Boolean(options.clean),
    browser: {
      headless: true,
      timeoutMs: 15000,
      waitUntil: 'load',
      concurrency: Math.max(1, Number(options.concurrency) || 4)
    },
    report: {
      title: `LocalePass Report · ${reportName}`,
      includeHtml: formats.includes('html'),
      includeJson: formats.includes('json'),
      includeMarkdown: formats.includes('markdown'),
      includeSarif: formats.includes('sarif'),
      autoOpen: Boolean(options.openReport),
      terminalSummary: true,
      maxIssuesInTerminal: 12,
      supportMessage: 'Thanks for installing LocalePass. Please star and fork on GitHub: https://github.com/CodingRasi/LocalePass · Support: https://buymeacoffee.com/mammadowr8'
    },
    visualDiff: {
      enabled: true,
      snapshotDir: resolve(process.cwd(), options.snapshotDir ?? `.localepass/snapshots/${reportName}`),
      diffDir: 'artifacts/diffs',
      compareAgainstSnapshots: true,
      generateDiffImages: true,
      failOnMissingSnapshots: false,
      allowedMismatchPixels: 100,
      allowedMismatchRatio: 0.001,
      fullPage: false
    },
    thresholds: {
      untranslatedOverlapRatio: 0.8,
      untranslatedCorpusMatchRatio: 0.35,
      overflowPixels: 2,
      maxTextExpansionRatio: 1.35,
      minTextLengthForTranslationCheck: 5
    },
    ignore: {
      selectors: [],
      textPatterns: []
    }
  };
}

function parseLocaleCodes(input: string): string[] {
  const codes = input.split(',').map((part) => part.trim()).filter(Boolean);
  return Array.from(new Set(codes.length ? codes : ['en']));
}

function normalizeTargetUrl(value: string, sampleLocale: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Please provide a URL or domain, for example: localepass scan nasa.com');
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol.replace('{locale}', sampleLocale));
    if (!parsed.hostname) throw new Error('Missing hostname');
    return withProtocol;
  } catch {
    throw new Error(`Could not understand target "${value}". Try something like: localepass scan nasa.com or localepass scan https://example.com/{locale}/pricing`);
  }
}

async function directoryHasFiles(pathValue: string | undefined): Promise<boolean> {
  if (!pathValue) return false;
  try {
    await access(pathValue, constants.F_OK);
  } catch {
    return false;
  }
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(pathValue, { recursive: true });
    return entries.length > 0;
  } catch {
    return false;
  }
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function inferNameFromUrl(value: string): string {
  try {
    const url = new URL(value.replace('{locale}', 'en'));
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.at(-1) || url.hostname.replace(/^www\./, '').split('.')[0] || 'page';
  } catch {
    return 'page';
  }
}

async function loadConfig(
  configPath: string,
  outputDirOverride?: string,
  snapshotDirOverride?: string,
  formats: Array<'html' | 'json' | 'markdown' | 'sarif'> = ['html', 'json', 'markdown', 'sarif'],
  clean = false
): Promise<ScanConfig> {
  const absolute = resolve(process.cwd(), configPath);
  const raw = await readFile(absolute, 'utf8');
  const config = JSON.parse(raw) as ScanConfig;

  if (!config.locales?.length) throw new Error('Config must contain at least one locale');
  if (!config.pages?.length) throw new Error('Config must contain at least one page');
  if (!config.baselineLocale) throw new Error('Config must contain baselineLocale');
  if (!config.locales.some((locale) => locale.code === config.baselineLocale)) {
    throw new Error(`Baseline locale ${config.baselineLocale} not found in locales list`);
  }

  const hydrated: ScanConfig = {
    ...config,
    outputDir: outputDirOverride ?? config.outputDir ?? 'reports/localepass',
    cleanOutputDir: clean || config.cleanOutputDir || false,
    viewports: config.viewports?.length ? config.viewports : DEFAULT_VIEWPORTS,
    browser: {
      headless: config.browser?.headless ?? true,
      timeoutMs: config.browser?.timeoutMs ?? 20_000,
      waitUntil: config.browser?.waitUntil ?? 'load',
      concurrency: Math.max(1, config.browser?.concurrency ?? 4)
    },
    report: {
      title: config.report?.title ?? 'LocalePass Report',
      includeHtml: formats.includes('html'),
      includeJson: formats.includes('json'),
      includeMarkdown: formats.includes('markdown'),
      includeSarif: formats.includes('sarif'),
      autoOpen: config.report?.autoOpen ?? false,
      terminalSummary: config.report?.terminalSummary ?? true,
      maxIssuesInTerminal: config.report?.maxIssuesInTerminal ?? 12,
      supportMessage: config.report?.supportMessage ?? ''
    },
    visualDiff: {
      enabled: config.visualDiff?.enabled ?? true,
      snapshotDir: resolve(process.cwd(), snapshotDirOverride ?? config.visualDiff?.snapshotDir ?? '.localepass/snapshots'),
      diffDir: config.visualDiff?.diffDir ?? 'artifacts/diffs',
      compareAgainstSnapshots: config.visualDiff?.compareAgainstSnapshots ?? true,
      generateDiffImages: config.visualDiff?.generateDiffImages ?? true,
      failOnMissingSnapshots: config.visualDiff?.failOnMissingSnapshots ?? false,
      allowedMismatchPixels: config.visualDiff?.allowedMismatchPixels ?? 100,
      allowedMismatchRatio: config.visualDiff?.allowedMismatchRatio ?? 0.001,
      fullPage: config.visualDiff?.fullPage ?? false
    },
    thresholds: {
      untranslatedOverlapRatio: 0.8,
      untranslatedCorpusMatchRatio: 0.35,
      overflowPixels: 2,
      maxTextExpansionRatio: 1.35,
      minTextLengthForTranslationCheck: 5,
      ...config.thresholds
    },
    ignore: {
      selectors: config.ignore?.selectors ?? [],
      textPatterns: config.ignore?.textPatterns ?? []
    }
  };

  if (hydrated.auth?.storageStatePath) {
    hydrated.auth.storageStatePath = resolve(process.cwd(), hydrated.auth.storageStatePath);
  }

  return hydrated;
}

async function runScan(
  config: ScanConfig,
  formats: Array<'html' | 'json' | 'markdown' | 'sarif'>,
  updateSnapshots: boolean
): Promise<Summary> {
  const outputDir = resolve(process.cwd(), config.outputDir!);
  if (config.cleanOutputDir) {
    await rm(outputDir, { recursive: true, force: true });
  }
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, 'artifacts', 'screenshots'), { recursive: true });
  if (config.visualDiff?.enabled) {
    await mkdir(config.visualDiff.snapshotDir!, { recursive: true });
    await mkdir(join(outputDir, config.visualDiff.diffDir!), { recursive: true });
  }

  const browser = await chromium.launch({
    headless: config.browser?.headless ?? true,
    executablePath: detectChromiumExecutable()
  });
  const results: LocalePageResult[] = [];

  try {
    const baselineLocale = config.locales.find((locale) => locale.code === config.baselineLocale)!;
    for (const viewport of config.viewports!) {
      for (const page of config.pages) {
        const baselineResult = await scanSinglePage(browser, config, page, baselineLocale, viewport, undefined, updateSnapshots);
        results.push(baselineResult);
        process.stdout.write(
          `${chalk.gray(baselineLocale.code.padEnd(8))} ${page.name.padEnd(20)} ${viewport.name.padEnd(10)} issues=${baselineResult.issues.length}\n`
        );

        const otherLocales = config.locales.filter((locale) => locale.code !== config.baselineLocale);
        const localeResults = await mapWithConcurrency(otherLocales, config.browser?.concurrency ?? 4, async (locale) => {
          const localeResult = await scanSinglePage(browser, config, page, locale, viewport, baselineResult, updateSnapshots);
          process.stdout.write(
            `${chalk.cyan(locale.code.padEnd(8))} ${page.name.padEnd(20)} ${viewport.name.padEnd(10)} issues=${localeResult.issues.length}\n`
          );
          return localeResult;
        });
        results.push(...localeResults);
      }
    }
  } finally {
    await browser.close();
  }

  const issueCountsByType: Record<string, number> = {};
  const issueCountsBySeverity: Record<string, number> = {};
  const snapshotStats = { matched: 0, different: 0, missing: 0, updated: 0, disabled: 0 };
  for (const result of results) {
    snapshotStats[result.visualDiff.status] += 1;
    for (const issue of result.issues) {
      issueCountsByType[issue.type] = (issueCountsByType[issue.type] ?? 0) + 1;
      issueCountsBySeverity[issue.severity] = (issueCountsBySeverity[issue.severity] ?? 0) + 1;
    }
  }

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    reportTitle: config.report?.title ?? 'LocalePass Report',
    totalScans: results.length,
    totalIssues: results.reduce((acc, item) => acc + item.issues.length, 0),
    issueCountsByType,
    issueCountsBySeverity,
    formats,
    snapshotStats,
    results
  };

  await writeArtifacts(outputDir, summary, config);
  await writeGithubSummaryIfAvailable(outputDir, summary);
  return summary;
}

async function scanSinglePage(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  config: ScanConfig,
  pageSpec: PageSpec,
  locale: LocaleSpec,
  viewport: ViewportSpec,
  baseline: LocalePageResult | undefined,
  updateSnapshots: boolean
): Promise<LocalePageResult> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    storageState: config.auth?.storageStatePath
  });
  if (locale.cookies?.length) {
    await context.addCookies(locale.cookies.map((cookie) => ({ path: '/', ...cookie })));
  }
  const page = await context.newPage();
  if (locale.headers) {
    await page.setExtraHTTPHeaders(locale.headers);
  }
  page.setDefaultTimeout(config.browser?.timeoutMs ?? 60_000);

  const rawUrl = locale.url ?? pageSpec.url;
  const scanUrl = materializeUrl(config.baseUrl, rawUrl, locale.code);
  const issues: DomIssue[] = [];
  try {
    await page.goto(scanUrl, { waitUntil: config.browser?.waitUntil ?? 'load', timeout: config.browser?.timeoutMs ?? 20_000 });
    if (pageSpec.waitForSelector) {
      await page.waitForSelector(pageSpec.waitForSelector, { timeout: config.browser?.timeoutMs ?? 20_000 });
    }
    if (pageSpec.waitFor) {
      await page.waitForTimeout(pageSpec.waitFor);
    }
  } catch (error) {
    issues.push({
      type: 'navigation-error',
      severity: 'error',
      message: error instanceof Error ? error.message : String(error),
      selector: 'document'
    });
  }

  const analysis = issues.some((issue) => issue.type === 'navigation-error')
    ? { issues: [], texts: [], textStats: { nodeCount: 0, totalLength: 0, avgLength: 0 } }
    : await page.evaluate(
        (args: EvaluateArgs) => {
          const {
            selectorsToIgnore,
            textPatternsToIgnore,
            overflowPixels,
            baselineTexts,
            untranslatedOverlapRatio,
            untranslatedCorpusMatchRatio,
            maxTextExpansionRatio,
            minTextLengthForTranslationCheck
          } = args;
          const issues: DomIssue[] = [];
          const seenIssueKeys = new Set<string>();
          const ignoredSelectors = new Set(selectorsToIgnore ?? []);
          const ignoredPatterns = (textPatternsToIgnore ?? [])
            .map((pattern: string) => {
              try {
                return new RegExp(pattern, 'i');
              } catch {
                return null;
              }
            })
            .filter(Boolean) as RegExp[];
          const baselineCorpus = (baselineTexts ?? []).map((x: string) => x.trim()).filter(Boolean);
          const baselineSet = new Set(baselineCorpus);
          const baselineTokenSet = new Set(
            baselineCorpus
              .flatMap((value: string) => value.toLowerCase().split(/\s+/))
              .map((token: string) => token.trim())
              .filter((token: string) => token.length >= 2)
          );
          const textNodes: string[] = [];
          const noisyClassPattern = /(ticker|marquee|carousel|slider|swiper|splide|slick|owl|track|rail|scroll|scroller|chip|chips|tab|tabs|nav|menu|breadcrumb|pager|pagination|toast|snackbar|notice|alert|banner|ads?|sponsor)/i;
          const noisyRolePattern = /^(navigation|tablist|menu|menubar|marquee)$/i;

          const isIgnored = (el: Element | null, text: string): boolean => {
            if (!el) return false;
            for (const selector of ignoredSelectors) {
              try {
                if (el.matches(selector) || el.closest(selector)) return true;
              } catch {
                // ignore malformed selectors
              }
            }
            return ignoredPatterns.some((pattern) => pattern.test(text));
          };

          const selectorFor = (el: Element): string => {
            if ((el as HTMLElement).id) return `#${(el as HTMLElement).id}`;
            const className =
              typeof (el as HTMLElement).className === 'string'
                ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.')
                : '';
            return `${el.tagName.toLowerCase()}${className ? '.' + className : ''}`;
          };

          const pushIssue = (issue: DomIssue) => {
            const key = `${issue.type}|${issue.selector}|${issue.text ?? ''}|${issue.message}`;
            if (!seenIssueKeys.has(key)) {
              seenIssueKeys.add(key);
              issues.push(issue);
            }
          };

          const visibleTextFor = (el: HTMLElement): string => {
            const ownText = Array.from(el.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent ?? '')
              .join(' ')
              .trim();
            return (ownText || el.innerText || '').trim().replace(/\s+/g, ' ');
          };

          const hasScrollableAncestor = (el: HTMLElement): boolean => {
            for (let current: HTMLElement | null = el; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (
                current.scrollWidth > current.clientWidth + overflowPixels &&
                ['auto', 'scroll'].includes(style.overflowX)
              ) {
                return true;
              }
            }
            return false;
          };

          const isLikelyNoisyContainer = (el: HTMLElement, text: string): boolean => {
            const classBlob = `${String(el.className || '')} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-test') || ''} ${el.getAttribute('role') || ''}`;
            if (noisyClassPattern.test(classBlob) || noisyRolePattern.test(el.getAttribute('role') || '')) return true;
            if (hasScrollableAncestor(el)) return true;
            if (text.length > 120 && el.children.length > 0) return true;
            if (el.querySelector('img, video, picture, svg, canvas')) return true;
            return false;
          };

          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode as HTMLElement;
            if (!el) continue;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 24 || rect.height < 10) continue;
            const text = visibleTextFor(el);
            if (!text || text.length < 2 || isIgnored(el, text)) continue;
            if (el.children.length > 6 && text.length > 80) continue;

            textNodes.push(text);
            const clippedX = el.scrollWidth - el.clientWidth > overflowPixels;
            const clippedY = el.scrollHeight - el.clientHeight > overflowPixels;
            const clipped = clippedX || clippedY;
            const likelyEllipsis = style.textOverflow === 'ellipsis' && clipped;
            const expansionRatio = el.clientWidth > 0 ? el.scrollWidth / Math.max(el.clientWidth, 1) : 1;
            const overflowIntentional = ['auto', 'scroll'].includes(style.overflowX) || ['auto', 'scroll'].includes(style.overflowY);
            const noisyContainer = isLikelyNoisyContainer(el, text);

            if (clipped && !overflowIntentional) {
              const issueType: IssueType = noisyContainer ? 'heuristic-warning' : likelyEllipsis ? 'text-clipped' : 'text-overflow';
              const severity: DomIssue['severity'] = noisyContainer ? 'info' : likelyEllipsis ? 'warning' : 'error';
              const message = noisyContainer
                ? 'Text may be clipped, but this looks like a ticker, carousel, or other intentionally constrained UI'
                : likelyEllipsis
                  ? 'Text appears ellipsized/clipped'
                  : 'Text overflows its container';
              pushIssue({
                type: issueType,
                severity,
                message,
                selector: selectorFor(el),
                text,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                ratio: Number(expansionRatio.toFixed(2))
              });
            } else if (expansionRatio > maxTextExpansionRatio && !noisyContainer && text.length < 80 && !/^(button|a|label|input|textarea|option)$/i.test(el.tagName)) {
              pushIssue({
                type: 'heuristic-warning',
                severity: 'info',
                message: `Text expansion ratio is high (${expansionRatio.toFixed(2)}x); layout may be fragile`,
                selector: selectorFor(el),
                text,
                ratio: Number(expansionRatio.toFixed(2))
              });
            }

            if (baselineSet.size > 0 && text.length >= minTextLengthForTranslationCheck && !noisyContainer) {
              if (baselineSet.has(text)) {
                pushIssue({
                  type: 'untranslated-text',
                  severity: 'warning',
                  message: 'Text matches baseline locale exactly; possible untranslated string',
                  selector: selectorFor(el),
                  text
                });
              } else {
                const tokens = text
                  .toLowerCase()
                  .split(/\s+/)
                  .map((token) => token.trim())
                  .filter((token) => token.length >= 2);
                if (tokens.length >= 3) {
                  const overlapping = tokens.filter((token) => baselineTokenSet.has(token)).length;
                  const overlapRatio = overlapping / tokens.length;
                  if (overlapRatio >= untranslatedOverlapRatio) {
                    pushIssue({
                      type: 'untranslated-text',
                      severity: 'warning',
                      message: `High token overlap with baseline locale (${Math.round(overlapRatio * 100)}%)`,
                      selector: selectorFor(el),
                      text,
                      ratio: Number(overlapRatio.toFixed(2))
                    });
                  }
                }
              }
            }
          }

          if (baselineSet.size > 0 && textNodes.length > 0) {
            const identicalNodes = textNodes.filter((text) => baselineSet.has(text)).length;
            const corpusRatio = identicalNodes / textNodes.length;
            if (corpusRatio >= untranslatedCorpusMatchRatio) {
              pushIssue({
                type: 'untranslated-text',
                severity: 'warning',
                message: `Large share of page text matches the baseline locale (${Math.round(corpusRatio * 100)}%)`,
                selector: 'body',
                ratio: Number(corpusRatio.toFixed(2))
              });
            }
          }

          const htmlLang = document.documentElement.getAttribute('lang') || '';
          if (!htmlLang) {
            pushIssue({
              type: 'missing-lang-attribute',
              severity: 'warning',
              message: 'Missing html[lang] attribute',
              selector: 'html'
            });
          }
          const bodyDir = document.body.getAttribute('dir') || document.documentElement.getAttribute('dir') || '';
          const containsArabicLike = /[\u0590-\u05FF\u0600-\u06FF]/.test(document.body.innerText || '');
          if (containsArabicLike && bodyDir.toLowerCase() !== 'rtl') {
            pushIssue({
              type: 'rtl-suspected',
              severity: 'warning',
              message: 'RTL script detected but document dir is not rtl',
              selector: 'body'
            });
          }

          const totalLength = textNodes.reduce((acc, value) => acc + value.length, 0);
          return {
            issues,
            texts: textNodes,
            textStats: {
              nodeCount: textNodes.length,
              totalLength,
              avgLength: textNodes.length ? totalLength / textNodes.length : 0
            }
          };
        },
        {
          selectorsToIgnore: [...(config.ignore?.selectors ?? []), ...(pageSpec.selectorsToIgnore ?? [])],
          textPatternsToIgnore: [...(config.ignore?.textPatterns ?? []), ...(pageSpec.textPatternsToIgnore ?? [])],
          overflowPixels: config.thresholds?.overflowPixels ?? 2,
          baselineTexts: baseline ? baseline.textCorpus : [],
          untranslatedOverlapRatio: config.thresholds?.untranslatedOverlapRatio ?? 0.8,
          untranslatedCorpusMatchRatio: config.thresholds?.untranslatedCorpusMatchRatio ?? 0.35,
          maxTextExpansionRatio: config.thresholds?.maxTextExpansionRatio ?? 1.35,
          minTextLengthForTranslationCheck: config.thresholds?.minTextLengthForTranslationCheck ?? 5
        }
      );

  const snapshotKey = buildSnapshotKey(pageSpec, locale, viewport);
  const screenshotPath = join(config.outputDir!, 'artifacts', 'screenshots', `${snapshotKey}.png`);
  await mkdir(dirname(resolve(process.cwd(), screenshotPath)), { recursive: true });
  await page.screenshot({
    path: resolve(process.cwd(), screenshotPath),
    fullPage: config.visualDiff?.fullPage ?? true,
    animations: 'disabled'
  });

  const visualDiff = await handleVisualDiff(config, screenshotPath, snapshotKey, updateSnapshots);
  if (visualDiff.status === 'missing') {
    issues.push({
      type: 'snapshot-missing',
      severity: config.visualDiff?.failOnMissingSnapshots ? 'error' : 'warning',
      message: 'No baseline snapshot found for visual regression comparison',
      selector: 'document',
      details: { snapshotPath: visualDiff.snapshotPath ?? null }
    });
  }
  if (visualDiff.status === 'different') {
    issues.push({
      type: 'snapshot-diff',
      severity: 'error',
      message: `Visual snapshot mismatch detected (${visualDiff.mismatchPixels} px, ratio ${Number((visualDiff.mismatchRatio ?? 0).toFixed(6))})`,
      selector: 'document',
      ratio: visualDiff.mismatchRatio,
      details: {
        mismatchPixels: visualDiff.mismatchPixels ?? 0,
        snapshotPath: visualDiff.snapshotPath ?? null,
        diffImagePath: visualDiff.diffImagePath ?? null
      }
    });
  }

  await context.close();

  return {
    pageName: pageSpec.name,
    locale: locale.code,
    viewport: viewport.name,
    screenshotPath,
    issues: [...issues, ...analysis.issues],
    textCorpus: analysis.texts,
    textStats: {
      nodeCount: analysis.textStats.nodeCount,
      avgLength: Number(analysis.textStats.avgLength.toFixed(2)),
      totalLength: analysis.textStats.totalLength
    },
    scanUrl,
    snapshotKey,
    visualDiff
  };
}

async function handleVisualDiff(
  config: ScanConfig,
  currentScreenshotPath: string,
  snapshotKey: string,
  updateSnapshots: boolean
): Promise<VisualDiffResult> {
  if (!config.visualDiff?.enabled || !config.visualDiff.compareAgainstSnapshots) {
    return { status: 'disabled' };
  }

  const absoluteCurrent = resolve(process.cwd(), currentScreenshotPath);
  const absoluteSnapshot = resolve(config.visualDiff.snapshotDir!, `${snapshotKey}.png`);
  const absoluteDiff = resolve(process.cwd(), config.outputDir!, config.visualDiff.diffDir!, `${snapshotKey}.diff.png`);

  if (updateSnapshots) {
    await mkdir(dirname(absoluteSnapshot), { recursive: true });
    await copyFile(absoluteCurrent, absoluteSnapshot);
    return {
      status: 'updated',
      snapshotPath: relative(process.cwd(), absoluteSnapshot)
    };
  }

  const exists = await fileExists(absoluteSnapshot);
  if (!exists) {
    return {
      status: 'missing',
      snapshotPath: relative(process.cwd(), absoluteSnapshot)
    };
  }

  await mkdir(dirname(absoluteDiff), { recursive: true });
  const comparison = await compareImages(absoluteSnapshot, absoluteCurrent, absoluteDiff);
  const mismatchRatio = comparison.mismatchRatio;
  const overPixels = comparison.mismatchPixels > (config.visualDiff.allowedMismatchPixels ?? 100);
  const overRatio = mismatchRatio > (config.visualDiff.allowedMismatchRatio ?? 0.001);

  if (overPixels || overRatio) {
    return {
      status: 'different',
      snapshotPath: relative(process.cwd(), absoluteSnapshot),
      diffImagePath: relative(process.cwd(), absoluteDiff),
      metric: comparison.metric,
      mismatchPixels: comparison.mismatchPixels,
      mismatchRatio
    };
  }

  if (await fileExists(absoluteDiff)) {
    await rm(absoluteDiff, { force: true });
  }

  return {
    status: 'matched',
    snapshotPath: relative(process.cwd(), absoluteSnapshot),
    metric: comparison.metric,
    mismatchPixels: comparison.mismatchPixels,
    mismatchRatio
  };
}

async function compareImages(snapshotPath: string, currentPath: string, diffPath: string): Promise<{
  metric: string;
  mismatchPixels: number;
  mismatchRatio: number;
}> {
  try {
    await execFile('compare', ['-metric', 'AE', snapshotPath, currentPath, diffPath], { env: process.env });
    return { metric: 'AE', mismatchPixels: 0, mismatchRatio: 0 };
  } catch (error: any) {
    const stderr = String(error?.stderr ?? '').trim();
    const stdout = String(error?.stdout ?? '').trim();
    const raw = stderr || stdout;
    const match = raw.match(/(\d+(?:\.\d+)?)/);
    const mismatchPixels = match ? Number(match[1]) : 0;
    const dimensions = await identifyImage(currentPath);
    const totalPixels = Math.max(dimensions.width * dimensions.height, 1);
    return {
      metric: 'AE',
      mismatchPixels,
      mismatchRatio: mismatchPixels / totalPixels
    };
  }
}

async function identifyImage(pathValue: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFile('identify', ['-format', '%w %h', pathValue]);
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width: width || 1, height: height || 1 };
  } catch {
    return { width: 1, height: 1 };
  }
}

async function writeArtifacts(outputDir: string, summary: Summary, config: ScanConfig): Promise<void> {
  for (const result of summary.results) {
    const textsPath = resolve(process.cwd(), result.screenshotPath.replace(/\.png$/, '.texts.json'));
    await mkdir(dirname(textsPath), { recursive: true });
    const corpus = Array.from(new Set(result.textCorpus));
    await writeFile(textsPath, JSON.stringify(corpus, null, 2), 'utf8');
  }

  const configCopyPath = join(outputDir, 'config.used.json');
  const sanitizedConfig = JSON.parse(JSON.stringify(config)) as ScanConfig;
  if (sanitizedConfig.locales) {
    for (const locale of sanitizedConfig.locales) {
      if (locale.cookies?.length) {
        locale.cookies = locale.cookies.map((cookie) => ({ ...cookie, value: '***redacted***' }));
      }
      if (locale.headers) {
        for (const key of Object.keys(locale.headers)) {
          if (/authorization|cookie|token/i.test(key)) {
            locale.headers[key] = '***redacted***';
          }
        }
      }
    }
  }
  if (sanitizedConfig.auth?.storageStatePath) {
    sanitizedConfig.auth.storageStatePath = relative(process.cwd(), sanitizedConfig.auth.storageStatePath);
  }
  await writeFile(configCopyPath, JSON.stringify(sanitizedConfig, null, 2), 'utf8');

  if (config.report?.includeJson) {
    await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  }
  if (config.report?.includeMarkdown) {
    await writeFile(join(outputDir, 'summary.md'), renderMarkdown(summary, config), 'utf8');
  }
  if (config.report?.includeHtml) {
    await writeFile(join(outputDir, 'report.html'), renderHtml(summary, config), 'utf8');
  }
  if (config.report?.includeSarif) {
    await writeFile(join(outputDir, 'summary.sarif.json'), JSON.stringify(renderSarif(summary), null, 2), 'utf8');
  }

  const schemaSource = resolve(process.cwd(), 'localepass.schema.json');
  const schemaDest = join(outputDir, 'localepass.schema.json');
  try {
    await copyFile(schemaSource, schemaDest);
  } catch {
    // optional artifact
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function severityRank(severity: DomIssue["severity"]): number {
  switch (severity) {
    case 'error':
      return 0;
    case 'warning':
      return 1;
    default:
      return 2;
  }
}

function severityColor(severity: DomIssue["severity"]) {
  switch (severity) {
    case 'error':
      return chalk.red;
    case 'warning':
      return chalk.yellow;
    default:
      return chalk.blue;
  }
}

function renderTerminalSummary(summary: Summary, maxIssues: number): void {
  const issueEntries = summary.results
    .flatMap((result) =>
      result.issues.map((issue) => ({
        pageName: result.pageName,
        locale: result.locale,
        viewport: result.viewport,
        issue
      }))
    )
    .sort((a, b) => severityRank(a.issue.severity) - severityRank(b.issue.severity));

  console.log(`
${chalk.bold('Top issues')}`);
  if (!issueEntries.length) {
    console.log(chalk.green('  No issues detected.'));
    return;
  }

  for (const [index, entry] of issueEntries.slice(0, maxIssues).entries()) {
    const tone = severityColor(entry.issue.severity);
    console.log(
      tone(
        `  ${index + 1}. [${entry.issue.severity}] ${entry.issue.type} · ${entry.pageName} · ${entry.locale} · ${entry.viewport}`
      )
    );
    console.log(`     ${entry.issue.message}`);
    if (entry.issue.text) console.log(chalk.gray(`     text: ${entry.issue.text.slice(0, 140)}`));
    const hint = remediationHint(entry.issue.type);
    if (hint) console.log(chalk.gray(`     fix: ${hint}`));
  }

  if (issueEntries.length > maxIssues) {
    console.log(chalk.gray(`  …and ${issueEntries.length - maxIssues} more. Open the HTML report for the full list.`));
  }
}

function remediationHint(type: IssueType): string {
  switch (type) {
    case 'text-overflow':
    case 'text-clipped':
      return 'Widen the container, allow wrapping, or shorten the localized copy.';
    case 'untranslated-text':
      return 'Replace fallback text with a locale-specific translation.';
    case 'missing-lang-attribute':
      return 'Set the correct html[lang] value for this locale.';
    case 'rtl-suspected':
      return 'Verify dir=rtl and check mirrored layout rules for RTL locales.';
    case 'snapshot-diff':
      return 'Review the visual diff. If expected, refresh the baseline snapshots.';
    case 'snapshot-missing':
      return 'Create baseline snapshots before comparing future runs.';
    case 'navigation-error':
      return 'Check the URL, auth state, and whether the page finished loading.';
    case 'heuristic-warning':
      return 'Review this manually. LocalePass marked it as low-confidence rather than a confirmed defect.';
    default:
      return '';
  }
}


function printTerminalSummary(summary: Summary, config?: ScanConfig): void {
  const topIssues = summary.results
    .flatMap((result) =>
      result.issues.map((issue) => ({
        ...issue,
        locale: result.locale,
        pageName: result.pageName,
        viewport: result.viewport
      }))
    )
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, config?.report?.maxIssuesInTerminal ?? 8);

  console.log('');
  console.log(chalk.bold('Top findings'));
  if (!topIssues.length) {
    console.log(chalk.green('✓ No issues detected.'));
  } else {
    for (const issue of topIssues) {
      const fix = remediationHint(issue.type);
      const marker = issue.severity === 'error' ? chalk.red('✖') : issue.severity === 'warning' ? chalk.yellow('▲') : chalk.blue('•');
      console.log(`${marker} ${chalk.bold(issue.locale)} ${issue.pageName} / ${issue.viewport} — ${issue.type}: ${issue.message}`);
      if (fix) console.log(chalk.gray(`  Fix: ${fix}`));
    }
  }
  if (config?.report?.supportMessage) {
    console.log('');
    console.log(chalk.cyan(config.report.supportMessage));
  }
}

async function openReport(reportPath: string): Promise<void> {
  const absolute = resolve(process.cwd(), reportPath);
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await execFile('open', [absolute]);
      console.log(chalk.green(`Opened ${relative(process.cwd(), absolute)}.`));
      return;
    }
    if (platform === 'win32') {
      await execFile('cmd', ['/c', 'start', '', absolute]);
      console.log(chalk.green(`Opened ${relative(process.cwd(), absolute)}.`));
      return;
    }
    await execFile('xdg-open', [absolute]);
    console.log(chalk.green(`Opened ${relative(process.cwd(), absolute)}.`));
  } catch {
    console.log(chalk.yellow(`Could not auto-open ${relative(process.cwd(), absolute)}.`));
  }
}

async function writeGithubSummaryIfAvailable(outputDir: string, summary: Summary): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const body = [
    `# ${summary.reportTitle}`,
    '',
    `- Total scans: ${summary.totalScans}`,
    `- Total issues: ${summary.totalIssues}`,
    `- Snapshot mismatches: ${summary.snapshotStats.different}`,
    `- Missing snapshots: ${summary.snapshotStats.missing}`,
    '',
    `Artifacts: \`${relative(process.cwd(), outputDir)}\``,
    '',
    '## Top findings',
    '',
    ...summary.results
      .filter((result) => result.issues.length)
      .slice(0, 20)
      .map(
        (result) =>
          `- **${result.pageName} / ${result.locale} / ${result.viewport}** — ${result.issues
            .slice(0, 3)
            .map((issue) => `${issue.type}: ${issue.message}`)
            .join('; ')}`
      ),
    ''
  ].join('\n');
  await writeFile(summaryPath, body, 'utf8');
}

function materializeUrl(baseUrl: string | undefined, input: string, localeCode: string): string {
  const prepared = input.replace(/\{locale\}/g, localeCode);
  if (/^https?:\/\//.test(prepared)) return prepared;
  if (!baseUrl) return prepared;
  return new URL(prepared, baseUrl).toString();
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}


function detectChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate));
}

function buildSnapshotKey(pageSpec: PageSpec, locale: LocaleSpec, viewport: ViewportSpec): string {
  const pageKey = sanitize(pageSpec.snapshotKey ?? pageSpec.name);
  return `${pageKey}-${locale.code}-${viewport.name}`;
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function renderHtml(summary: Summary, config: ScanConfig): string {
  const grouped = new Map<string, LocalePageResult[]>();
  for (const result of summary.results) {
    const key = `${result.pageName}__${result.viewport}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(result);
  }

  const sections = Array.from(grouped.entries())
    .map(([key, items]) => {
      const [pageName, viewport] = key.split('__');
      const cards = items
        .sort((a, b) => a.locale.localeCompare(b.locale))
        .map((item) => {
          const orderedIssues = [...item.issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
          const issueMarkup = orderedIssues.length
            ? `<ul>${orderedIssues
                .map(
                  (issue) => `<li><strong>${escapeHtml(issue.type)}</strong> · <em>${escapeHtml(issue.severity)}</em>: ${escapeHtml(issue.message)}${
                    issue.text ? ` — <code>${escapeHtml(issue.text.slice(0, 160))}</code>` : ''
                  }</li>`
                )
                .join('')}</ul>`
            : '<p class="clean">No issues detected.</p>';
          const visualMeta = `<p class="meta"><strong>Snapshot:</strong> ${escapeHtml(item.visualDiff.status)}${
            item.visualDiff.mismatchPixels != null ? ` · <strong>Mismatch px:</strong> ${item.visualDiff.mismatchPixels}` : ''
          }</p>`;
          const baselineMarkup = item.visualDiff.snapshotPath
            ? `<figure><figcaption>Baseline snapshot</figcaption><img src="${escapeHtml(relativeFromReport(item.visualDiff.snapshotPath))}" alt="${escapeHtml(item.pageName)} ${escapeHtml(item.locale)} baseline" loading="lazy" /></figure>`
            : '<div class="notice">No baseline snapshot stored.</div>';
          const currentMarkup = `<figure><figcaption>Current screenshot</figcaption><img src="${escapeHtml(relativeFromReport(item.screenshotPath))}" alt="${escapeHtml(item.pageName)} ${escapeHtml(item.locale)}" loading="lazy" /></figure>`;
          const diffMarkup = item.visualDiff.status === 'different' && item.visualDiff.diffImagePath
            ? `<figure><figcaption>Diff</figcaption><img src="${escapeHtml(relativeFromReport(item.visualDiff.diffImagePath))}" alt="${escapeHtml(item.pageName)} ${escapeHtml(item.locale)} diff" loading="lazy" /></figure>`
            : '<div class="notice">No visual regression detected.</div>';
          return `
            <article class="card">
              <div class="card-head">
                <h3>${escapeHtml(item.locale)}</h3>
                <span class="badge ${item.issues.some((issue) => issue.severity === 'error') ? 'bad' : item.issues.length ? 'warn' : 'good'}">${item.issues.length} findings</span>
              </div>
              <p class="meta"><strong>URL:</strong> ${escapeHtml(item.scanUrl)}</p>
              <p class="meta"><strong>Text nodes:</strong> ${item.textStats.nodeCount} · <strong>Avg len:</strong> ${item.textStats.avgLength}</p>
              ${visualMeta}
              <div class="shots">
                ${currentMarkup}
                ${baselineMarkup}
                ${diffMarkup}
              </div>
              ${issueMarkup}
            </article>
          `;
        })
        .join('');
      return `<section><h2>${escapeHtml(pageName)} <span>${escapeHtml(viewport)}</span></h2><div class="grid">${cards}</div></section>`;
    })
    .join('');

  const issueTypeBadges = Object.entries(summary.issueCountsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<div class="pill">${escapeHtml(type)}: ${count}</div>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(summary.reportTitle)}</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: #0b1020; color: #ecf2ff; }
    header { padding: 32px; border-bottom: 1px solid rgba(255,255,255,0.08); position: sticky; top: 0; background: rgba(11,16,32,.96); backdrop-filter: blur(8px); z-index: 10; }
    main { padding: 24px 32px 64px; }
    h1,h2,h3,p,figure { margin: 0; }
    h2 { margin-bottom: 16px; display: flex; gap: 10px; align-items: baseline; }
    h2 span { font-size: 14px; opacity: .72; text-transform: uppercase; letter-spacing: .08em; }
    section { margin-bottom: 40px; }
    .summary { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .pill { background: #151c34; border: 1px solid rgba(255,255,255,0.08); padding: 10px 14px; border-radius: 999px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; }
    .card { background: #141b33; border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 16px; box-shadow: 0 20px 50px rgba(0,0,0,.22); }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }
    .badge { border-radius: 999px; padding: 6px 10px; font-size: 12px; }
    .badge.good { background: rgba(43, 182, 115, .16); color: #7df0b7; }
    .badge.warn { background: rgba(245, 158, 11, .16); color: #fcd34d; }
    .badge.bad { background: rgba(255, 92, 92, .16); color: #ff9f9f; }
    .meta { font-size: 13px; opacity: .82; margin-bottom: 8px; }
    .clean { color: #7df0b7; }
    .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 12px 0; }
    figure { display: flex; flex-direction: column; gap: 8px; }
    figcaption { font-size: 12px; color: #9fb3d9; text-transform: uppercase; letter-spacing: .08em; }
    img { width: 100%; border-radius: 12px; border: 1px solid rgba(255,255,255,.08); background: #0f1630; }
    .notice { min-height: 120px; display: grid; place-items: center; border-radius: 12px; border: 1px dashed rgba(255,255,255,.14); color: #9fb3d9; background: rgba(255,255,255,.02); padding: 16px; text-align: center; }
    ul { padding-left: 18px; line-height: 1.45; }
    code { white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(summary.reportTitle)}</h1>
    <div class="summary">
      <div class="pill">Runs: ${summary.totalScans}</div>
      <div class="pill">Issues: ${summary.totalIssues}</div>
      <div class="pill">Snapshot diff: ${summary.snapshotStats.different}</div>
      <div class="pill">Missing snapshots: ${summary.snapshotStats.missing}</div>
      <div class="pill">Version: ${escapeHtml(summary.toolVersion)}</div>
      ${issueTypeBadges}
    </div>
  </header>
  <main>${sections}</main>
  ${config?.report?.supportMessage ? `<footer style="max-width:1200px;margin:24px auto 0;padding:0 16px 40px;color:#94a3b8">${escapeHtml(config.report.supportMessage)}</footer>` : ''}
</body>
</html>`;
}

function renderMarkdown(summary: Summary, config?: ScanConfig): string {
  const lines: string[] = [];
  lines.push(`# ${summary.reportTitle}`);
  lines.push('');
  lines.push(`- Generated at: ${summary.generatedAt}`);
  lines.push(`- LocalePass version: ${summary.toolVersion}`);
  lines.push(`- Total scans: ${summary.totalScans}`);
  lines.push(`- Total issues: ${summary.totalIssues}`);
  lines.push(`- Snapshot matched: ${summary.snapshotStats.matched}`);
  lines.push(`- Snapshot different: ${summary.snapshotStats.different}`);
  lines.push(`- Snapshot missing: ${summary.snapshotStats.missing}`);
  lines.push('');
  lines.push('## Issue counts by type');
  lines.push('');
  for (const [type, count] of Object.entries(summary.issueCountsByType).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push('');
  lines.push('## Results');
  lines.push('');
  for (const result of summary.results) {
    lines.push(`### ${result.pageName} · ${result.locale} · ${result.viewport}`);
    lines.push(`- URL: ${result.scanUrl}`);
    lines.push(`- Screenshot: ${result.screenshotPath}`);
    lines.push(`- Snapshot status: ${result.visualDiff.status}`);
    if (result.visualDiff.diffImagePath) lines.push(`- Diff image: ${result.visualDiff.diffImagePath}`);
    lines.push(`- Text nodes: ${result.textStats.nodeCount}`);
    if (!result.issues.length) {
      lines.push(`- Issues: none`);
    } else {
      lines.push(`- Issues: ${result.issues.length}`);
      for (const issue of result.issues) {
        lines.push(`  - [${issue.severity}] ${issue.type}: ${issue.message}${issue.text ? ` — ${issue.text.slice(0, 160)}` : ''}`);
      }
    }
    lines.push('');
  }
  if (config?.report?.supportMessage) {
    lines.push('---');
    lines.push(config.report.supportMessage);
  }
  return lines.join('\n');
}


function renderSarif(summary: Summary) {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'LocalePass',
            version: summary.toolVersion,
            informationUri: 'https://github.com/yourname/localepass',
            rules: Array.from(new Set(summary.results.flatMap((result) => result.issues.map((issue) => issue.type)))).map((type) => ({
              id: type,
              name: type,
              shortDescription: { text: type },
              help: { text: `LocalePass detected ${type}` },
              defaultConfiguration: { level: type.includes('missing') || type.includes('warning') ? 'warning' : 'error' }
            }))
          }
        },
        results: summary.results.flatMap((result) =>
          result.issues.map((issue) => ({
            ruleId: issue.type,
            level: issue.severity === 'error' ? 'error' : 'warning',
            message: {
              text: `${result.pageName} / ${result.locale} / ${result.viewport}: ${issue.message}`
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: result.screenshotPath
                  }
                }
              }
            ]
          }))
        )
      }
    ]
  };
}

function relativeFromReport(pathValue: string): string {
  return pathValue.split(/[/\\]/).slice(-1)[0];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sampleConfig(): ScanConfig {
  return {
    baseUrl: 'http://localhost:3000',
    baselineLocale: 'en',
    outputDir: 'reports/localepass',
    cleanOutputDir: true,
    auth: {
      storageStatePath: '.auth/localepass-storage-state.json'
    },
    browser: {
      headless: true,
      timeoutMs: 20000,
      waitUntil: 'load',
      concurrency: 4
    },
    report: {
      title: 'LocalePass Report',
      includeHtml: true,
      includeJson: true,
      includeMarkdown: true,
      includeSarif: true,
      autoOpen: false,
      terminalSummary: true,
      maxIssuesInTerminal: 12,
      supportMessage: 'Fork the repo on CodingRasi and support the project at https://buymeacoffee.com/mammadowr8 if LocalePass helps you.'
    },
    ignore: {
      selectors: ['[data-localepass-ignore]', '.cookie-banner', 'script', 'style'],
      textPatterns: ['^\\d+$']
    },
    visualDiff: {
      enabled: true,
      snapshotDir: '.localepass/snapshots',
      diffDir: 'artifacts/diffs',
      compareAgainstSnapshots: true,
      generateDiffImages: true,
      failOnMissingSnapshots: false,
      allowedMismatchPixels: 100,
      allowedMismatchRatio: 0.001,
      fullPage: false
    },
    pages: [
      { name: 'landing', url: '/{locale}/', waitFor: 500, waitForSelector: 'main' },
      { name: 'pricing', url: '/{locale}/pricing', waitFor: 500, waitForSelector: 'main' }
    ],
    locales: [
      { name: 'English', code: 'en', headers: { 'Accept-Language': 'en' } },
      { name: 'German', code: 'de', headers: { 'Accept-Language': 'de' } },
      { name: 'Japanese', code: 'ja', headers: { 'Accept-Language': 'ja' } }
    ],
    viewports: DEFAULT_VIEWPORTS,
    thresholds: {
      untranslatedOverlapRatio: 0.8,
      untranslatedCorpusMatchRatio: 0.35,
      overflowPixels: 2,
      maxTextExpansionRatio: 1.35,
      minTextLengthForTranslationCheck: 5
    }
  };
}
