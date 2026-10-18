/**
 * Minimal dependency-free unified diff (line based, LCS). Deterministic.
 * Used by `optipack --diff`.
 */

export function splitLines(text) {
  const lines = text.split('\n');
  // A trailing newline produces a final empty element; drop it for diffing.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Array((n + 1) * (m + 1)).fill(0);
  const at = (i, j) => dp[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  return at;
}

/**
 * Compute ops: [{type: 'eq'|'del'|'add', aLine, bLine, text}]
 */
export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  const at = lcsTable(A, B);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      ops.push({ type: 'eq', aLine: i + 1, bLine: j + 1, text: A[i] });
      i++; j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ type: 'del', aLine: i + 1, bLine: j + 1, text: A[i] });
      i++;
    } else {
      ops.push({ type: 'add', aLine: i + 1, bLine: j + 1, text: B[j] });
      j++;
    }
  }
  while (i < A.length) ops.push({ type: 'del', aLine: i + 1, bLine: j + 1, text: A[i++] });
  while (j < B.length) ops.push({ type: 'add', aLine: i + 1, bLine: j + 1, text: B[j++] });
  return ops;
}

/**
 * Render a unified diff for one file. Returns '' when there are no changes.
 */
export function unifiedDiff(fileA, fileB, aText, bText, contextLines = 3) {
  const ops = diffLines(aText, bText);
  if (ops.every((o) => o.type === 'eq')) return '';
  const out = [];
  out.push(`--- a/${fileA}`);
  out.push(`+++ b/${fileB}`);
  // Group into hunks.
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].type === 'eq') { idx++; continue; }
    // Find hunk start: back up `contextLines` eq ops.
    let start = idx;
    let ctxBefore = 0;
    while (start > 0 && ops[start - 1].type === 'eq' && ctxBefore < contextLines) { start--; ctxBefore++; }
    // Extend hunk end while changes or within context of next change.
    let end = idx;
    let pendingEq = 0;
    let k = idx;
    while (k < ops.length) {
      if (ops[k].type !== 'eq') { end = k; pendingEq = 0; k++; }
      else {
        pendingEq++;
        if (pendingEq > contextLines * 2) break;
        end = k;
        k++;
      }
    }
    // Trim trailing eq to contextLines.
    let endTrim = end;
    let ctxAfter = 0;
    while (endTrim > start && ops[endTrim].type === 'eq' && ctxAfter < contextLines) { endTrim--; ctxAfter++; }
    endTrim = Math.min(end, endTrim + (ops[endTrim] && ops[endTrim].type === 'eq' ? 0 : 0));
    // hunk = ops[start..endTrim]
    const hunk = ops.slice(start, endTrim + 1);
    const aStart = hunk[0].aLine;
    const bStart = hunk[0].bLine;
    let aCount = 0;
    let bCount = 0;
    for (const o of hunk) {
      if (o.type !== 'add') aCount++;
      if (o.type !== 'del') bCount++;
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of hunk) {
      if (o.type === 'eq') out.push(' ' + o.text);
      else if (o.type === 'del') out.push('-' + o.text);
      else out.push('+' + o.text);
    }
    idx = endTrim + 1;
    while (idx < ops.length && ops[idx].type === 'eq') idx++;
  }
  return out.join('\n') + '\n';
}
