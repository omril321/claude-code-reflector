/**
 * Report generation and console output
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import type {
  Tier1Result,
  ReflectorReport,
  FlagType,
  Tier2Result,
  VerificationReport,
} from '../types/findings.js';
import { getModelPricing } from '../analyzer/anthropic-client.js';

const PROJECT_DIR = join(import.meta.dirname, '..', '..');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model = 'sonnet',
): number {
  const pricing = getModelPricing(model);
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

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

  const report: ReflectorReport = {
    generatedAt: new Date().toISOString(),
    sessionsScanned: results.length,
    sessionsWithFindings,
    totalFindings,
    findingsByType,
    estimatedCost: estimateCost(totalInputTokens, totalOutputTokens),
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
  const cost = estimateCost(totalInputTokens, totalOutputTokens);

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
  console.log(chalk.dim(`Estimated cost: $${cost.toFixed(4)}`));
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
  console.log(chalk.dim(`Estimated cost: $${cost.toFixed(4)}`));
  console.log();
}

export async function writeVerificationReport(
  results: Tier2Result[],
  sourceReport: string,
  model: string,
): Promise<string> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let findingsInput = 0;
  let findingsConfirmed = 0;
  let findingsRejected = 0;

  for (const result of results) {
    totalInputTokens += result.tokenUsage.inputTokens;
    totalOutputTokens += result.tokenUsage.outputTokens;
    findingsInput += result.verdicts.length;
    findingsConfirmed += result.confirmedCount;
    findingsRejected += result.rejectedCount;
  }

  const report: VerificationReport = {
    generatedAt: new Date().toISOString(),
    sourceReport,
    model,
    sessionsVerified: results.length,
    findingsInput,
    findingsConfirmed,
    findingsRejected,
    estimatedCost: estimateCost(totalInputTokens, totalOutputTokens, model),
    results,
  };

  const latestPath = join(REPORTS_DIR, 'latest-verified.json');
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2), 'utf-8');

  return latestPath;
}

export function printVerificationSummary(results: Tier2Result[], model: string): void {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let findingsInput = 0;
  let findingsConfirmed = 0;
  let findingsRejected = 0;

  for (const result of results) {
    totalInputTokens += result.tokenUsage.inputTokens;
    totalOutputTokens += result.tokenUsage.outputTokens;
    findingsInput += result.verdicts.length;
    findingsConfirmed += result.confirmedCount;
    findingsRejected += result.rejectedCount;
  }

  const cost = estimateCost(totalInputTokens, totalOutputTokens, model);

  console.log();
  console.log(chalk.bold('Verification Report'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Sessions verified:   ${chalk.cyan(results.length)}`);
  console.log(`Findings input:      ${findingsInput}`);
  console.log(`Findings confirmed:  ${chalk.green(findingsConfirmed)}`);
  console.log(`Findings rejected:   ${chalk.red(findingsRejected)}`);
  console.log();
  console.log(chalk.dim(`Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`));
  console.log(chalk.dim(`Estimated cost: $${cost.toFixed(4)}`));
  console.log();
  console.log(chalk.gray('─'.repeat(40)));

  for (const result of results) {
    const confirmed = result.verdicts.filter(v => v.verified);
    const rejected = result.verdicts.filter(v => !v.verified);

    if (confirmed.length === 0 && rejected.length === 0) continue;

    console.log();
    console.log(chalk.bold(result.summary || result.sessionId.slice(0, 8)));
    console.log(`  ${chalk.dim(`${confirmed.length} confirmed, ${rejected.length} rejected`)}`);
    console.log();

    for (const verdict of confirmed) {
      const f = verdict.originalFinding;
      const typeColor =
        f.type === 'missing-rule' ? chalk.red :
        f.type === 'skill-unused' ? chalk.yellow :
        chalk.magenta;
      const skillLabel = f.skillName ? ` ${f.skillName}` : '';
      console.log(`  ${chalk.green('✓')} ${typeColor(`[${f.type}]`)} ${chalk.dim(`(${verdict.confidence})`)}${skillLabel}`);
      console.log(`     ${chalk.white('Reasoning:')} ${verdict.reasoning}`);
      console.log(`     ${chalk.green('Recommendation:')} ${verdict.refinedRecommendation ?? f.recommendation}`);
      if (verdict.refinedSuggestedRule) {
        console.log(`     ${chalk.blue('Suggested rule:')} ${verdict.refinedSuggestedRule}`);
      }
      if (verdict.evidence.length > 0) {
        console.log(`     ${chalk.dim('Evidence:')}`);
        for (const e of verdict.evidence) {
          console.log(`       ${chalk.dim('•')} ${e}`);
        }
      }
      console.log();
    }

    for (const verdict of rejected) {
      const f = verdict.originalFinding;
      console.log(`  ${chalk.red('✗')} ${chalk.dim(`[${f.type}]`)} ${f.skillName ?? ''}`);
      console.log(`     ${chalk.dim('Rejected:')} ${verdict.reasoning}`);
      console.log();
    }
  }

  console.log(chalk.dim(`Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`));
  console.log(chalk.dim(`Estimated cost: $${cost.toFixed(4)}`));
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

export async function printLatestVerifiedReport(asJson: boolean): Promise<void> {
  const latestPath = join(REPORTS_DIR, 'latest-verified.json');
  try {
    const content = await fs.readFile(latestPath, 'utf-8');
    if (asJson) {
      console.log(content);
    } else {
      const report: VerificationReport = JSON.parse(content);
      printVerificationSummary(report.results, report.model);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(chalk.yellow('No verified reports found. Run "reflector verify" first.'));
    } else {
      throw err;
    }
  }
}
