/**
 * Permission analysis report generation and console output
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type { PermissionReport, PermissionSuggestion } from '../types/permissions.js';

const PROJECT_DIR = join(import.meta.dirname, '..', '..');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

export async function writePermissionReport(report: PermissionReport): Promise<string> {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'latest-permissions.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  return reportPath;
}

export function printPermissionSummary(report: PermissionReport): void {
  console.log();
  console.log(chalk.bold('Permission Suggestions'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Sessions scanned:    ${chalk.cyan(report.sessionsScanned)}`);
  console.log(`Total tool uses:     ${chalk.cyan(report.totalToolUses)}`);
  console.log(`Already covered:     ${chalk.green(report.alreadyCovered)}`);
  console.log(`Suggestions:         ${chalk.bold(report.suggestions.length)}`);
  console.log(`Skipped (unsafe):    ${chalk.red(report.skipped.length)}`);

  if (report.suggestions.length > 0) {
    console.log();
    for (let i = 0; i < report.suggestions.length; i++) {
      const s = report.suggestions[i];
      const countLabel = formatCountLabel(s);
      const scopeLabel = s.scope === 'global'
        ? 'Add to global permissions'
        : `Add to project permissions (${s.scopeDetail})`;

      console.log(`  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(s.pattern)}  ${chalk.dim(countLabel)}`);
      console.log(`     ${chalk.dim('→')} ${scopeLabel}`);
    }
  }

  if (report.skipped.length > 0) {
    console.log();
    console.log(chalk.dim('Skipped (unsafe):'));
    for (const s of report.skipped) {
      const timesLabel = s.approvalCount === 1 ? 'time' : 'times';
      console.log(`  ${chalk.red(s.pattern)}  ${chalk.dim(`approved ${s.approvalCount} ${timesLabel}`)} ${chalk.dim('—')} ${chalk.dim(s.reason)}`);
    }
  }

  console.log();
}

export async function printLatestPermissionReport(asJson: boolean): Promise<void> {
  const latestPath = join(REPORTS_DIR, 'latest-permissions.json');
  try {
    const content = await fs.readFile(latestPath, 'utf-8');
    if (asJson) {
      console.log(content);
    } else {
      const report: PermissionReport = JSON.parse(content);
      printPermissionSummary(report);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(chalk.yellow('No permission reports found. Run "reflector permissions" first.'));
    } else {
      throw err;
    }
  }
}

function formatCountLabel(s: PermissionSuggestion): string {
  const timesLabel = s.approvalCount === 1 ? 'time' : 'times';
  const sessionsLabel = s.sessionCount === 1 ? 'session' : 'sessions';
  return `approved ${s.approvalCount} ${timesLabel} across ${s.sessionCount} ${sessionsLabel}`;
}
