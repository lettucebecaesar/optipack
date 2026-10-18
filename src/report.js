/**
 * Report accumulation and serialization.
 */

export function newFileReport(relPath, beforeBytes) {
  return {
    path: relPath,
    hotFunctions: 0,
    transforms: {},
    bails: [],
    lint: [],
    residualAllocs: { closures: 0, arrays: 0, objects: 0 },
    bytes: { before: beforeBytes, after: 0 },
  };
}

export class Report {
  constructor(level) {
    this.level = level;
    this.files = [];
    this.warnings = [];
    this.totals = { transforms: 0, bails: 0, warnings: 0 };
  }

  addFile(fr) {
    this.files.push(fr);
    this.totals.transforms += Object.values(fr.transforms).reduce((a, b) => a + b, 0);
    this.totals.bails += fr.bails.length;
    this.totals.warnings += this.warningsForFile(fr.path);
    return fr;
  }

  warningsForFile(p) {
    return this.warnings.filter((w) => w.path === p).length;
  }

  warn(entry) {
    this.warnings.push(entry);
    this.totals.warnings++;
  }

  finish() {
    // Recompute totals defensively (warnings are global, files are fixed).
    this.totals.transforms = this.files.reduce(
      (a, f) => a + Object.values(f.transforms).reduce((x, y) => x + y, 0), 0
    );
    this.totals.bails = this.files.reduce((a, f) => a + f.bails.length, 0);
    this.totals.warnings = this.warnings.length;
    return this;
  }

  toJSON() {
    return {
      level: this.level,
      files: this.files,
      warnings: this.warnings,
      totals: { transforms: this.totals.transforms, bails: this.totals.bails, warnings: this.totals.warnings },
    };
  }

  serialize() {
    return JSON.stringify(this.finish().toJSON(), null, 2) + '\n';
  }
}

/** Shared per-file pass context handed to every pass. */
export class PassContext {
  constructor({ fileName, pragmas, hot, fileReport, warningsSink, config }) {
    this.fileName = fileName;
    this.pragmas = pragmas;
    this.hot = hot; // HotInfo or null
    this.fileReport = fileReport;
    this.warningsSink = warningsSink; // (entry) => void
    this.config = config;
  }

  applied(id) {
    this.fileReport.transforms[id] = (this.fileReport.transforms[id] || 0) + 1;
  }

  bail(line, code, reason) {
    if (!line) return; // generated nodes have no source line to report
    this.fileReport.bails.push({ line, transform: code, reason });
  }

  warn(line, transform, message) {
    this.warningsSink({ path: this.fileName, line: line ?? 0, transform, message });
    this.fileReport.warnings = (this.fileReport.warnings || 0) + 1;
  }

  isDisabled(path, ...ids) {
    return this.pragmas ? this.pragmas.isDisabled(path, ...ids) : false;
  }

  isHot(node) {
    return this.hot ? this.hot.isHot(node) : false;
  }
}
