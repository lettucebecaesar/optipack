/**
 * Pragma extraction and queries.
 *
 * Supported pragmas (exact syntax):
 *   // optipack: off                      (must be the FIRST comment in the file)
 *   // optipack-disable <transformId|all>  (line immediately before a node)
 *   // optipack-hot                        (line immediately before a function)
 *
 * "Immediately before" tolerates other comment lines stacked in between, but
 * nothing but comments may appear between the pragma and the target node.
 */

const DISABLE_RE = /^optipack-disable\s+(.+?)\s*$/;
const HOT_RE = /^optipack-hot\s*$/;
const OFF_RE = /^optipack:\s*off\s*$/;

export function analyzePragmas(ast) {
  const comments = ast.comments || [];
  const first = comments.length > 0 ? comments[0] : null;
  const fileOff = !!(first && first.type === 'CommentLine' && OFF_RE.test(first.value.trim()));

  // Every line covered by any comment (for adjacency computation).
  const coveredLines = new Set();
  for (const c of comments) {
    for (let l = c.loc.start.line; l <= c.loc.end.line; l++) coveredLines.add(l);
  }

  // line -> Set of ids (may include 'all') for the node starting on that line.
  const disableByLine = new Map();
  const hotLines = new Set();
  for (const c of comments) {
    if (c.type !== 'CommentLine') continue;
    const val = c.value.trim();
    const dm = DISABLE_RE.exec(val);
    if (dm) {
      const target = c.loc.end.line + 1;
      if (!disableByLine.has(target)) disableByLine.set(target, new Set());
      for (const id of dm[1].split(',')) {
        const s = id.trim();
        if (s) disableByLine.get(target).add(s);
      }
    } else if (HOT_RE.test(val)) {
      hotLines.add(c.loc.end.line + 1);
    }
  }

  return { fileOff, disableByLine, hotLines, coveredLines, comments };
}

/**
 * Does the pragma comment on line `pragmaLine` (a CommentLine occupying that
 * line) sit immediately before a node starting at `nodeStartLine`? Only other
 * comment lines may appear in between.
 */
function adjacent(coveredLines, pragmaLine, nodeStartLine) {
  if (nodeStartLine <= pragmaLine) return false;
  for (let l = pragmaLine + 1; l < nodeStartLine; l++) {
    if (!coveredLines.has(l)) return false;
  }
  return true;
}

export class PragmaInfo {
  constructor(ast) {
    this.info = analyzePragmas(ast);
  }

  get fileOff() {
    return this.info.fileOff;
  }

  /**
   * Set of ids disabled for `node` via an adjacent `// optipack-disable`
   * comment, or null when none applies. Considers the node itself and its
   * start line only; callers walk ancestors.
   */
  disabledAt(node) {
    if (!node.loc) return null;
    const start = node.loc.start.line;
    const direct = this.info.disableByLine.get(start);
    if (direct) return direct;
    // Stacked pragmas: a pragma further up whose gap to the node is all comments.
    for (const [line, ids] of this.info.disableByLine) {
      if (line < start && adjacent(this.info.coveredLines, line - 1, start)) return ids;
    }
    return null;
  }

  /**
   * Walk the path's ancestor chain (self included) looking for a disable
   * pragma matching one of the given ids (transform ids or codes) or 'all'.
   */
  isDisabled(path, ...ids) {
    let p = path;
    while (p) {
      const ids2 = this.disabledAt(p.node);
      if (ids2) {
        if (ids2.has('all')) return true;
        for (const id of ids) if (ids2.has(id)) return true;
      }
      p = p.parentPath;
    }
    return false;
  }

  /** Is there an adjacent `// optipack-hot` comment for a node at this line? */
  isHotLine(line) {
    if (!line) return false;
    if (this.info.hotLines.has(line)) return true;
    for (const l of this.info.hotLines) {
      if (l < line && adjacent(this.info.coveredLines, l - 1, line)) return true;
    }
    return false;
  }
}
