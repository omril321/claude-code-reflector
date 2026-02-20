/**
 * Report generation and console output
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type { Tier1Result, ReflectorReport, FlagType } from '../types/findings.js';

const PROJECT_DIR = join(import.meta.dirname, '..', '..');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

// Haiku pricing per million tokens (Vertex AI)
const HAIKU_INPUT_PRICE = 1.0;
const HAIKU_OUTPUT_PRICE = 5.0;

export async function writeReport(results: Tier1Result[]): Promise<string> {
  const findingsByType: Record<FlagType, number> = {
    'missing-rule': 0,
    'skill-unused': 0,
    'skill-correction': 0,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const result of results) {
    totalInputTokens += result.tokenUsage.inputTokens;
    totalOutputTokens += result.tokenUsage.outputTokens;
    for (const flag of result.flags) {
      findingsByType[flag.type]++;
    }
  }

  const totalFindings = Object.values(findingsByType).reduce((a, b) => a + b, 0);
  const sessionsWithFindings = results.filter(r => r.flags.length > 0).length;
  const estimatedCost =
    (totalInputTokens / 1_000_000) * HAIKU_INPUT_PRICE +
    (totalOutputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE;

  const report: ReflectorReport = {
    generatedAt: new Date().toISOString(),
    sessionsScanned: results.length,
    sessionsWithFindings,
    totalFindings,
    findingsByType,
    estimatedCost,
    results,
  };

  // Write timestamped report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(REPORTS_DIR, timestamp);
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Update latest pointer
  const latestPath = join(REPORTS_DIR, 'latest.json');
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2), 'utf-8');

  return reportPath;
}

export function printSummary(results: Tier1Result[]): void {
  const findingsByType: Record<FlagType, number> = {
    'missing-rule': 0,
    'skill-unused': 0,
    'skill-correction': 0,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const result of results) {
    totalInputTokens += result.tokenUsage.inputTokens;
    totalOutputTokens += result.tokenUsage.outputTokens;
    for (const flag of result.flags) {
      findingsByType[flag.type]++;
    }
  }

  const totalFindings = Object.values(findingsByType).reduce((a, b) => a + b, 0);
  const sessionsWithFindings = results.filter(r => r.flags.length > 0).length;
  const estimatedCost =
    (totalInputTokens / 1_000_000) * HAIKU_INPUT_PRICE +
    (totalOutputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE;

  console.log();
  console.log(chalk.bold('Reflector Report'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Sessions scanned:    ${chalk.cyan(results.length)}`);
  console.log(`Sessions w/ findings: ${chalk.yellow(sessionsWithFindings)}`);
  console.log(`Total findings:      ${chalk.bold(totalFindings)}`);
  console.log();
  console.log(chalk.dim('By type:'));
  console.log(`  missing-rule:      ${findingsByType['missing-rule']}`);
  console.log(`  skill-unused:      ${findingsByType['skill-unused']}`);
  console.log(`  skill-correction:  ${findingsByType['skill-correction']}`);
  console.log();
  console.log(chalk.dim(`Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`));
  console.log(chalk.dim(`Estimated cost: $${estimatedCost.toFixed(4)}`));
  console.log();

  // Print top findings
  const allFlags = results
    .flatMap(r => r.flags.map(f => ({ ...f, sessionSummary: r.summary, sessionId: r.sessionId })))
    .sort((a, b) => {
      const conf = { high: 3, medium: 2, low: 1 };
      return conf[b.confidence] - conf[a.confidence];
    });

  if (allFlags.length > 0) {
    console.log(chalk.bold('Top Findings:'));
    console.log();
    for (const flag of allFlags.slice(0, 10)) {
      const typeColor = flag.type === 'missing-rule' ? chalk.red : flag.type === 'skill-unused' ? chalk.yellow : chalk.magenta;
      console.log(`  ${typeColor(`[${flag.type}]`)} ${chalk.dim(`(${flag.confidence})`)} ${flag.reasoning}`);
      if (flag.suggestedRule) {
        console.log(`    ${chalk.green('Suggested rule:')} ${flag.suggestedRule}`);
      }
      if (flag.skillName) {
        console.log(`    ${chalk.blue('Skill:')} ${flag.skillName}`);
      }
      console.log(`    ${chalk.dim(`Session: ${flag.sessionSummary}`)}`);
      console.log();
    }
  }
}

export async function printLatestReport(asJson: boolean): Promise<void> {
  const latestPath = join(REPORTS_DIR, 'latest.json');
  try {
    const content = await fs.readFile(latestPath, 'utf-8');
    if (asJson) {
      console.log(content);
    } else {
      const report: ReflectorReport = JSON.parse(content);
      printSummary(report.results);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(chalk.yellow('No reports found. Run "reflector scan" first.'));
    } else {
      throw err;
    }
  }
}
