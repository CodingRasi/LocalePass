const cyan = '\x1b[36m';
const magenta = '\x1b[35m';
const yellow = '\x1b[33m';
const green = '\x1b[32m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

const lines = [
  `${cyan}╔════════════════════════════════════════════════════════════════════╗${reset}`,
  `${cyan}║${reset} ${bold}Thanks for installing LocalePass${reset}${' '.repeat(29)}${cyan}║${reset}`,
  `${cyan}║${reset} Catch localization and UI issues before release.${' '.repeat(14)}${cyan}║${reset}`,
  `${cyan}╠════════════════════════════════════════════════════════════════════╣${reset}`,
  `${cyan}║${reset} ${yellow}★${reset} Fork / star on GitHub: ${magenta}CodingRasi/LocalePass${reset}${' '.repeat(18)}${cyan}║${reset}`,
  `${cyan}║${reset} ${green}☕${reset} Support the project: ${magenta}https://buymeacoffee.com/mammadowr8${reset} ${cyan}║${reset}`,
  `${cyan}║${reset} ${dim}Quick start:${reset} npm run build  &&  npm run test:demo:quick${' '.repeat(8)}${cyan}║${reset}`,
  `${cyan}╚════════════════════════════════════════════════════════════════════╝${reset}`,
];

console.log('\n' + lines.join('\n') + '\n');
