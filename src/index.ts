#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readAllSessionEntries, findSessionEntry } from './scanner/index-reader.js';
import { parseSession } from './scanner/session-parser.js';
import { loadContext } from './scanner/skill-catalog.js';
import { analyzeTier1 } from './analyzer/tier1.js';
import { verifySession } from './analyzer/tier2.js';
import { resolveModelId } from './analyzer/anthropic-client.js';
import { loadState, saveState, isSessionProcessed, markSessionProcessed } from './state/manager.js';
import {
  writeReport,
  printSummary,
  printLatestReport,
  writeVerificationReport,
  printVerificationSummary,
  printLatestVerifiedReport,
} from './reporter/index.js';
import { DEFAULT_STATE } from './types/state.js';
import type { Tier1Result, ReflectorReport, Tier2Result } from './types/findings.js';
import { promises as fs } from 'fs';
import { join } from 'path';

const DEFAULT_EXCLUDES = ['/Users/omrila/private/claude-code-reflector'];
const DEFAULT_MIN_MESSAGES = 4;

const PROJECT_DIR = join(import.meta.dirname, '..');
const STATE_FILE = join(PROJECT_DIR, 'state.json');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

const program = new Command();

program
  .name('reflector')
  .description('Analyze Claude Code sessions to surface missing rules and skill gaps')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan and analyze Claude Code sessions')
  .option('--all', 'Ignore state, process all sessions')
  .option('--dry-run', 'List sessions without calling AI')
  .option('--exclude <paths...>', 'Project paths to exclude', DEFAULT_EXCLUDES)
  .option('--min-messages <n>', 'Minimum message count', String(DEFAULT_MIN_MESSAGES))
  .option('--session <id>', 'Process a single session by ID')
  .option('--limit <n>', 'Maximum sessions to process')
  .action(async (opts) => {
    const minMessages = parseInt(opts.minMessages, 10);
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

    const spinner = ora('Scanning sessions...').start();

    const entries = await readAllSessionEntries({
      excludedPaths: opts.exclude,
      minMessages,
      sessionId: opts.session,
    });

    spinner.succeed(`Found ${entries.length} sessions matching filters`);

    if (entries.length === 0) {
      console.log(chalk.yellow('No sessions to process.'));
      return;
    }

    // Load state for incremental processing
    const state = opts.all ? { ...DEFAULT_STATE, processedSessions: {} } : await loadState();

    // Filter out already-processed sessions
    let toProcess = entries.filter(
      e => !isSessionProcessed(state, e.sessionId, e.modified),
    );

    if (toProcess.length === 0) {
      console.log(chalk.green('All matching sessions already processed. Use --all to re-process.'));
      return;
    }

    if (limit) {
      toProcess = toProcess.slice(0, limit);
    }

    console.log(`Processing ${chalk.cyan(toProcess.length)} session(s)...`);

    if (opts.dryRun) {
      console.log();
      for (const entry of toProcess) {
        console.log(`  ${chalk.dim(entry.sessionId.slice(0, 8))} ${entry.summary || entry.firstPrompt.slice(0, 60)}`);
        console.log(`    ${chalk.dim(`${entry.messageCount} messages | ${entry.projectPath} | ${entry.modified}`)}`);
      }
      console.log();
      console.log(chalk.dim(`(dry run - no API calls made)`));
      return;
    }

    // Load context for analysis
    const context = await loadContext();
    const results: Tier1Result[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const entry = toProcess[i];
      const label = `[${i + 1}/${toProcess.length}] ${entry.summary || entry.sessionId.slice(0, 8)}`;
      const sessionSpinner = ora(label).start();

      try {
        const session = await parseSession(entry);

        if (!session.conversationText.trim()) {
          sessionSpinner.warn(`${label} - empty conversation, skipping`);
          continue;
        }

        const result = await analyzeTier1(session, context);
        results.push(result);

        // Save state after each session (crash-safe)
        markSessionProcessed(state, entry.sessionId, entry.modified, result.flags.length);
        await saveState(state);

        if (result.flags.length > 0) {
          sessionSpinner.succeed(`${label} - ${chalk.yellow(`${result.flags.length} finding(s)`)}`);
        } else {
          sessionSpinner.succeed(`${label} - ${chalk.green('clean')}`);
        }
      } catch (err) {
        sessionSpinner.fail(`${label} - ${chalk.red((err as Error).message)}`);
      }
    }

    // Write report
    if (results.length > 0) {
      const reportPath = await writeReport(results);
      console.log(chalk.dim(`Report saved to: ${reportPath}`));
      printSummary(results);
    } else {
      console.log(chalk.yellow('No sessions were analyzed.'));
    }
  });

program
  .command('verify')
  .description('Deep-verify Tier 1 findings against full session conversations')
  .option('--model <name>', 'Model to use (haiku|sonnet or full model ID)', 'sonnet')
  .option('--report <path>', 'Path to Tier 1 report to verify (defaults to latest)')
  .option('--dry-run', 'Show what would be verified without calling AI')
  .action(async (opts) => {
    const modelId = resolveModelId(opts.model);

    // Load Tier 1 report
    const reportPath = opts.report ?? join(REPORTS_DIR, 'latest.json');
    let report: ReflectorReport;
    try {
      const content = await fs.readFile(reportPath, 'utf-8');
      report = JSON.parse(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(chalk.yellow('No Tier 1 report found. Run "reflector scan" first.'));
      } else {
        console.log(chalk.red(`Failed to read report: ${(err as Error).message}`));
      }
      return;
    }

    // Filter to sessions with findings
    const sessionsWithFindings = report.results.filter(r => r.flags.length > 0);
    const totalFindings = sessionsWithFindings.reduce((sum, r) => sum + r.flags.length, 0);

    if (sessionsWithFindings.length === 0) {
      console.log(chalk.green('No findings to verify — Tier 1 report is clean.'));
      return;
    }

    console.log(`Verifying ${chalk.cyan(totalFindings)} finding(s) across ${chalk.cyan(sessionsWithFindings.length)} session(s) with ${chalk.dim(modelId)}`);

    if (opts.dryRun) {
      console.log();
      for (const result of sessionsWithFindings) {
        console.log(`  ${chalk.dim(result.sessionId.slice(0, 8))} ${result.summary}`);
        for (const flag of result.flags) {
          const skillLabel = flag.skillName ? ` (${flag.skillName})` : '';
          console.log(`    ${chalk.dim('•')} [${flag.type}] ${flag.confidence}${skillLabel}`);
        }
      }
      console.log();
      console.log(chalk.dim('(dry run - no API calls made)'));
      return;
    }

    const context = await loadContext();
    const results: Tier2Result[] = [];

    for (let i = 0; i < sessionsWithFindings.length; i++) {
      const tier1Result = sessionsWithFindings[i];
      const label = `[${i + 1}/${sessionsWithFindings.length}] ${tier1Result.summary || tier1Result.sessionId.slice(0, 8)}`;
      const spinner = ora(label).start();

      try {
        const entry = await findSessionEntry(tier1Result.sessionId);
        if (!entry) {
          spinner.warn(`${label} - session not found, skipping`);
          continue;
        }

        const result = await verifySession(entry, tier1Result.flags, context, modelId);
        results.push(result);

        const confirmed = result.confirmedCount;
        const rejected = result.rejectedCount;
        spinner.succeed(
          `${label} - ${chalk.green(`${confirmed} confirmed`)}, ${chalk.red(`${rejected} rejected`)}`,
        );
      } catch (err) {
        spinner.fail(`${label} - ${chalk.red((err as Error).message)}`);
      }
    }

    if (results.length > 0) {
      const verifiedPath = await writeVerificationReport(results, reportPath, opts.model);
      console.log(chalk.dim(`Verified report saved to: ${verifiedPath}`));
      printVerificationSummary(results, opts.model);
    } else {
      console.log(chalk.yellow('No sessions were verified.'));
    }
  });

program
  .command('pipeline')
  .description('Full pipeline: scan → verify → report')
  .option('--all', 'Ignore state, process all sessions')
  .option('--exclude <paths...>', 'Project paths to exclude', DEFAULT_EXCLUDES)
  .option('--min-messages <n>', 'Minimum message count', String(DEFAULT_MIN_MESSAGES))
  .option('--limit <n>', 'Maximum sessions to process')
  .option('--model <name>', 'Model for verification (haiku|sonnet)', 'sonnet')
  .action(async (opts) => {
    const minMessages = parseInt(opts.minMessages, 10);
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

    // --- Tier 1: Scan ---
    console.log(chalk.bold('\n── Tier 1: Scan ──\n'));

    const spinner = ora('Scanning sessions...').start();
    const entries = await readAllSessionEntries({
      excludedPaths: opts.exclude,
      minMessages,
    });
    spinner.succeed(`Found ${entries.length} sessions matching filters`);

    const state = opts.all ? { ...DEFAULT_STATE, processedSessions: {} } : await loadState();
    let toProcess = entries.filter(
      e => !isSessionProcessed(state, e.sessionId, e.modified),
    );

    if (toProcess.length === 0) {
      console.log(chalk.green('All sessions already processed. Use --all to re-process.'));
      return;
    }

    if (limit) {
      toProcess = toProcess.slice(0, limit);
    }

    console.log(`Processing ${chalk.cyan(toProcess.length)} session(s)...`);

    const context = await loadContext();
    const scanResults: Tier1Result[] = [];

    for (let i = 0; i < toProcess.length; i++) {
      const entry = toProcess[i];
      const label = `[${i + 1}/${toProcess.length}] ${entry.summary || entry.sessionId.slice(0, 8)}`;
      const sessionSpinner = ora(label).start();

      try {
        const session = await parseSession(entry);
        if (!session.conversationText.trim()) {
          sessionSpinner.warn(`${label} - empty conversation, skipping`);
          continue;
        }

        const result = await analyzeTier1(session, context);
        scanResults.push(result);

        markSessionProcessed(state, entry.sessionId, entry.modified, result.flags.length);
        await saveState(state);

        if (result.flags.length > 0) {
          sessionSpinner.succeed(`${label} - ${chalk.yellow(`${result.flags.length} finding(s)`)}`);
        } else {
          sessionSpinner.succeed(`${label} - ${chalk.green('clean')}`);
        }
      } catch (err) {
        sessionSpinner.fail(`${label} - ${chalk.red((err as Error).message)}`);
      }
    }

    if (scanResults.length === 0) {
      console.log(chalk.yellow('No sessions were analyzed.'));
      return;
    }

    const reportPath = await writeReport(scanResults);
    printSummary(scanResults);

    // --- Tier 2: Verify ---
    const sessionsWithFindings = scanResults.filter(r => r.flags.length > 0);
    const totalFindings = sessionsWithFindings.reduce((sum, r) => sum + r.flags.length, 0);

    if (sessionsWithFindings.length === 0) {
      console.log(chalk.green('\nNo findings to verify — all sessions clean.'));
      return;
    }

    const modelId = resolveModelId(opts.model);
    console.log(chalk.bold('\n── Tier 2: Verify ──\n'));
    console.log(`Verifying ${chalk.cyan(totalFindings)} finding(s) across ${chalk.cyan(sessionsWithFindings.length)} session(s) with ${chalk.dim(modelId)}`);

    const verifyResults: Tier2Result[] = [];

    for (let i = 0; i < sessionsWithFindings.length; i++) {
      const tier1Result = sessionsWithFindings[i];
      const label = `[${i + 1}/${sessionsWithFindings.length}] ${tier1Result.summary || tier1Result.sessionId.slice(0, 8)}`;
      const vSpinner = ora(label).start();

      try {
        const entry = await findSessionEntry(tier1Result.sessionId);
        if (!entry) {
          vSpinner.warn(`${label} - session not found, skipping`);
          continue;
        }

        const result = await verifySession(entry, tier1Result.flags, context, modelId);
        verifyResults.push(result);

        vSpinner.succeed(
          `${label} - ${chalk.green(`${result.confirmedCount} confirmed`)}, ${chalk.red(`${result.rejectedCount} rejected`)}`,
        );
      } catch (err) {
        vSpinner.fail(`${label} - ${chalk.red((err as Error).message)}`);
      }
    }

    if (verifyResults.length > 0) {
      await writeVerificationReport(verifyResults, reportPath, opts.model);

      // --- Final Report ---
      console.log(chalk.bold('\n── Verified Results ──'));
      printVerificationSummary(verifyResults, opts.model);
    }
  });

program
  .command('report')
  .description('View the latest report')
  .option('--json', 'Output raw JSON')
  .option('--verified', 'Show the verified report instead of Tier 1')
  .action(async (opts) => {
    if (opts.verified) {
      await printLatestVerifiedReport(opts.json);
    } else {
      await printLatestReport(opts.json);
    }
  });

program
  .command('reset')
  .description('Clear processing state')
  .action(async () => {
    try {
      await fs.unlink(STATE_FILE);
      console.log(chalk.green('State cleared.'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(chalk.dim('No state file found.'));
      } else {
        throw err;
      }
    }
  });

program.parse();
