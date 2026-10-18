/**
 * Pipeline — parse, analyze, transform, verify, report. One file at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';

import { PragmaInfo } from './pragma.js';
import { analyzeHotPaths } from './hotpath.js';
import { PassContext, newFileReport, Report } from './report.js';
import { PASSES } from './passes/index.js';
import { LEVEL_RANK } from './config.js';
import { runLint } from './lint.js';
import { walkPack, copyFile, writeFile } from './pack-walker.js';

const _traverse = traverse.default || traverse;
const _generate = generate.default || generate;

export class ParseFailureError extends Error {
  constructor(fileName, message, loc) {
    // Babel parse errors carry a flat Position {line, column}; be tolerant.
    const line = loc ? (loc.start ? loc.start.line : loc.line) : null;
    const col = loc ? (loc.start ? loc.start.column : loc.column) : null;
    const where = line !== null && line !== undefined ? `${line}:${col}` : '?';
    super(`${fileName}:${where} ${message}`);
    this.fileName = fileName;
    this.loc = loc || null;
    this.code = 2;
  }
}

export class InternalError extends Error {
  constructor(message) {
    super(message);
    this.code = 3;
  }
}

const PARSE_OPTIONS = {
  sourceType: 'module',
  errorRecovery: false,
  ranges: true,
  attachComment: true,
};

export function parseSource(fileName, source) {
  try {
    return parse(source, PARSE_OPTIONS);
  } catch (e) {
    throw new ParseFailureError(fileName, e.message, e.loc);
  }
}

export function generateCode(ast) {
  const out = _generate(ast, {
    comments: true,
    compact: false,
    concise: false,
    minified: false,
    retainLines: false,
    retainFunctionParens: true,
    jsescOption: { minimal: true },
  });
  let code = out.code;
  if (!code.endsWith('\n')) code += '\n';
  return code;
}

/**
 * Transform one script source. Returns { code, fileReport }.
 */
export function transformSource(fileName, source, config) {
  const fileReport = newFileReport(fileName, Buffer.byteLength(source, 'utf8'));
  const ast = parseSource(fileName, source);

  const pragmas = new PragmaInfo(ast);
  if (pragmas.fileOff) {
    // `// optipack: off` — emit unchanged.
    fileReport.bytes.after = fileReport.bytes.before;
    return { code: source, fileReport };
  }

  const hot = analyzeHotPaths(ast, pragmas, { transitiveDepth: config.hotPath.transitiveDepth });
  fileReport.hotFunctions = hot.hotCount;

  const warnings = [];
  const ctx = new PassContext({
    fileName,
    pragmas,
    hot,
    fileReport,
    warningsSink: (w) => warnings.push(w),
    config,
  });

  // Program path reused across passes; scope is re-crawled before each pass
  // so binding information stays fresh after rewrites.
  let programPath = null;
  _traverse(ast, {
    Program(p) {
      programPath = p;
      p.stop();
    },
  });
  if (!programPath) throw new InternalError(`${fileName}: no Program node`);

  const only = config.only || null;
  for (const pass of PASSES) {
    // Level filter.
    let enabled = LEVEL_RANK[pass.level] <= LEVEL_RANK[config.level];
    // Explicit config overrides.
    if (config.transforms[pass.id] === true) enabled = true;
    if (config.transforms[pass.id] === false) enabled = false;
    // only/except.
    if (only) enabled = only.has(pass.id);
    if (!enabled) continue;

    try {
      programPath.scope.crawl();
      pass.run(programPath, ctx);
    } catch (e) {
      if (e instanceof ParseFailureError) throw e;
      throw new InternalError(`${fileName}: pass ${pass.id} failed: ${e.message}\n${e.stack}`);
    }
  }

  // Lint (no rewriting).
  if (config.lint) {
    try {
      runLint(programPath, ctx, hot);
    } catch (e) {
      throw new InternalError(`${fileName}: lint failed: ${e.message}\n${e.stack}`);
    }
  }

  // Generate + verify round-trip parse.
  const code = generateCode(ast);
  try {
    parse(code, PARSE_OPTIONS);
  } catch (e) {
    throw new InternalError(
      `${fileName}: round-trip parse failed (internal error): ${e.message} at line ${e.loc ? e.loc.start.line : '?'}`
    );
  }

  fileReport.bytes.after = Buffer.byteLength(code, 'utf8');
  fileReport.warnings = warnings.filter((w) => w.path === fileName).length;
  return { code, fileReport, warnings };
}

/**
 * Run the whole pack: transform scripts, copy everything else.
 * Returns the aggregate Report.
 */
export function runPack(inputDir, outputDir, config, { dryRun = false } = {}) {
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    const err = new Error(`input pack directory not found: ${inputDir}`);
    err.code = 1;
    throw err;
  }

  const report = new Report(config.level);
  const { scripts, copies } = walkPack(inputDir);

  if (!dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const f of copies) {
    if (!dryRun) copyFile(f.abs, path.join(outputDir, f.relPath));
  }

  for (const f of scripts) {
    const source = fs.readFileSync(f.abs, 'utf8');
    const { code, fileReport, warnings } = transformSource(f.relPath, source, config);
    if (!dryRun) {
      writeFile(path.join(outputDir, f.relPath), code);
    }
    report.addFile(fileReport);
    for (const w of warnings) report.warn(w);
  }

  return report;
}
