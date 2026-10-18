/**
 * optipack CLI.
 *
 *   optipack <inputPackDir> <outputPackDir> [options]
 *
 * Exit codes: 0 success · 1 usage/config error · 2 parse failure · 3 internal error
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import { loadConfigFile, mergeCliOverrides, LEVELS } from './config.js';
import { runPack, ParseFailureError, InternalError } from './pipeline.js';
import { PASS_IDS, PASS_CODES } from './passes/index.js';
import { unifiedDiff } from './diff.js';

export async function main(argv) {
  const program = new Command();
  program
    .name('optipack')
    .description('QuickJS-targeted micro-optimizing pre-processor for Minecraft Bedrock behavior-pack scripts')
    .version('1.0.0')
    .argument('<inputPackDir>', 'behavior pack directory to read')
    .argument('<outputPackDir>', 'directory to write the optimized pack into')
    .option('--level <level>', 'optimization level: safe | balanced | risky')
    .option('--config <path>', 'config file (default: ./optipack.config.json when present)')
    .option('--only <ids>', 'comma-separated transform ids to run exclusively')
    .option('--except <ids>', 'comma-separated transform ids to skip')
    .option('--dry-run', 'analyze + report, write nothing (prints report to stdout unless --report is given)')
    .option('--diff', 'print unified diffs per changed file')
    .option('--report <path>', `report file (default: <outputPackDir>/optipack-report.json)`)
    .option('--lint <bool>', 'enable/disable the lint pass (true|false)', parseBoolOpt)
    .exitOverride();

  let opts;
  const args = [];
  try {
    program.parse(argv, { from: 'node' });
    opts = program.opts();
    args.push(...program.args);
  } catch (e) {
    if (e && e.code === 'commander.version') {
      console.log(e.message);
      return 0;
    }
    if (e && (e.code === 'commander.help' || e.code === 'commander.helpDisplayed')) {
      return 0;
    }
    if (e && e.code === 'commander.missingArgument') {
      console.error(`optipack: ${e.message}`);
      return 1;
    }
    console.error(`optipack: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }

  const [inputDir, outputDir] = args;
  if (!inputDir || !outputDir) {
    console.error('optipack: both <inputPackDir> and <outputPackDir> are required');
    return 1;
  }
  if (opts.level !== undefined && !LEVELS.includes(opts.level)) {
    console.error(`optipack: invalid --level "${opts.level}" (expected one of ${LEVELS.join(', ')})`);
    return 1;
  }
  if (opts.lint !== undefined && typeof opts.lint !== 'boolean') {
    console.error('optipack: --lint expects true or false');
    return 1;
  }

  // Resolve config file: explicit path, else ./optipack.config.json.
  let configPath = opts.config;
  if (configPath && !fs.existsSync(configPath)) {
    console.error(`optipack: config file not found: ${configPath}`);
    return 1;
  }
  let config;
  try {
    const loaded = loadConfigFile(configPath);
    config = loaded.config;
    configPath = loaded.path;
  } catch (e) {
    console.error(`optipack: ${e.message}`);
    return 1;
  }

  // CLI overrides.
  const cli = {
    level: opts.level,
    only: opts.only,
    except: opts.except,
    lint: opts.lint,
    config: configPath,
  };
  try {
    config = mergeCliOverrides(config, cli, PASS_IDS, PASS_CODES);
  } catch (e) {
    console.error(`optipack: ${e.message}`);
    return 1;
  }

  const dryRun = !!opts.dryRun;
  const reportPath = opts.report !== undefined
    ? opts.report
    : path.join(outputDir, 'optipack-report.json');

  // Capture original sources for --diff.
  const beforeSources = new Map();
  if (opts.diff) {
    const { walkPack } = await import('./pack-walker.js');
    if (fs.existsSync(inputDir)) {
      const { scripts } = walkPack(inputDir);
      for (const s of scripts) beforeSources.set(s.relPath, fs.readFileSync(s.abs, 'utf8'));
    }
  }

  try {
    const report = runPack(inputDir, outputDir, config, { dryRun });
    const json = report.serialize();

    if (dryRun) {
      if (opts.report !== undefined) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, json);
        console.log(`optipack: dry run — wrote report to ${reportPath} (no pack files written)`);
      } else {
        console.log(json);
      }
    } else {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, json);
    }

    if (opts.diff) {
      const { walkPack } = await import('./pack-walker.js');
      const { scripts } = walkPack(inputDir);
      for (const s of scripts) {
        const outAbs = path.join(outputDir, s.relPath);
        if (!fs.existsSync(outAbs)) continue;
        const after = fs.readFileSync(outAbs, 'utf8');
        const before = beforeSources.get(s.relPath) ?? '';
        const d = unifiedDiff(s.relPath, s.relPath, before, after);
        if (d) process.stdout.write(d);
      }
    }

    // Human summary on success (only when not printing the full report).
    if (!dryRun || opts.report !== undefined) {
      const t = report.totals;
      console.log(
        `optipack: ${report.files.length} script file(s), level ${report.level}, ` +
        `${t.transforms} transform(s) applied, ${t.bails} bail(s), ${t.warnings} warning(s)`
      );
      console.log(`optipack: report written to ${reportPath}${dryRun ? ' (dry run: no pack files written)' : ''}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ParseFailureError) {
      console.error(`optipack: parse failure — ${e.message}`);
      return 2;
    }
    if (e instanceof InternalError) {
      console.error(`optipack: internal error — ${e.message}`);
      return 3;
    }
    if (e && e.code === 1) {
      console.error(`optipack: ${e.message}`);
      return 1;
    }
    console.error(`optipack: internal error — ${e && e.stack ? e.stack : String(e)}`);
    return 3;
  }
}

function parseBoolOpt(v) {
  if (v === 'true' || v === '' || v === undefined) return true;
  if (v === 'false') return false;
  // Signal an invalid value; validated by the caller.
  return v;
}
