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

  console.log(chalk.gray('─'.repeat(40)));

  // Group findings by session
  const typeLabels: Record<FlagType, [string, string]> = {
    'missing-rule': ['missing rule', 'missing rules'],
    'skill-unused': ['unused skill', 'unused skills'],
    'skill-correction': ['skill correction', 'skill corrections'],
  };

  const sessionsWithFlags = results.filter(r => r.flags.length > 0);

  for (const result of sessionsWithFlags) {
    console.log();
    console.log(chalk.bold(result.summary || result.sessionId.slice(0, 8)));

    // Session summary line (e.g., "3 unused skills, 1 missing rule")
    const typeCounts: Partial<Record<FlagType, number>> = {};
    for (const flag of result.flags) {
      typeCounts[flag.type] = (typeCounts[flag.type] || 0) + 1;
    }
    const parts = (Object.entries(typeCounts) as [FlagType, number][]).map(
      ([type, count]) => `${count} ${typeLabels[type][count === 1 ? 0 : 1]}`
    );
    console.log(`  ${chalk.dim(parts.join(', '))}`);
    console.log();

    // Sort findings: high → medium → low
    const sortedFlags = [...result.flags].sort((a, b) => {
      const conf = { high: 3, medium: 2, low: 1 };
      return conf[b.confidence] - conf[a.confidence];
    });

    for (let i = 0; i < sortedFlags.length; i++) {
      const flag = sortedFlags[i];
      const typeColor =
        flag.type === 'missing-rule' ? chalk.red :
        flag.type === 'skill-unused' ? chalk.yellow :
        chalk.magenta;
      const skillLabel = flag.skillName ? ` ${flag.skillName}` : '';
      console.log(`  ${i + 1}. ${typeColor(`[${flag.type}]`)} ${chalk.dim(`(${flag.confidence})`)}${skillLabel}`);
      console.log(`     ${chalk.white('What happened:')} ${flag.whatHappened}`);
      console.log(`     ${chalk.green('Recommendation:')} ${flag.recommendation}`);
      if (flag.suggestedRule) {
        console.log(`     ${chalk.blue('Suggested rule:')} ${flag.suggestedRule}`);
      }
      console.log();
    }
  }

  // Footer
  console.log(chalk.dim(`Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`));
  console.log(chalk.dim(`Estimated cost: $${estimatedCost.toFixed(4)}`));
  console.log();
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
