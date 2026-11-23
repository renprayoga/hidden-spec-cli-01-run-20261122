// main.ts — mend, the CLI SPEC.md (version 1) specifies.
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// mend applies an edit an AI model wrote, in one of four formats, to a tree
// of text files: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// tool calls. Every edit is found at the first of three matching tiers and
// every file is changed or none is.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A move an edit made: [old path, new path]. */
type MovePair = [string, string];
/** One edit: apply it to the tree, or throw a Fail; report the moves it made. */
type Edit = (tree: Tree) => MovePair[];

// ---------------------------------------------------------------------------
// Files: a file's line break, its lines and whether it ends with a break.
// ---------------------------------------------------------------------------

interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}

/** Positions i where O matches lines[i..] at the given tier, at or after `from`. */
function occurrencesFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const first = normLine(o[0], tier);
  const rest = o.slice(1).map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    if (normLine(lines[i], tier) !== first) continue;
    let ok = true;
    for (let j = 0; j < rest.length; j++) {
      if (normLine(lines[i + 1 + j], tier) !== rest[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences; null when none. */
function matchFrom(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesFrom(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function matchSingleLine(lines: string[], want: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const nw = normLine(want, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === nw) return i;
    }
  }
  return null;
}

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

/** Section 5, tier 2: replace a line's leading P with F; empty and whitespace-only lines are untouched. */
function reindented(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (p !== '' && !line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One line of N: its text, and the index of the O line it is the context of, or -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/** The lines that replace the matched lines: context lines are the file's own, other lines are re-indented at tier 2. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]) : '';
  for (const nl of n) {
    if (nl.ctx >= 0) out.push(fileLines[pos + nl.ctx]);
    else if (tier === 2) out.push(reindented(nl.text, p, f));
    else out.push(nl.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      return [];
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return [];
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return [];
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: string; // ' ' context, '-' old, '+' new, '\' no-newline marker
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPairOld: boolean;
  hasPairNew: boolean;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** `diff --git a/<X> b/<Y>` or null when the line is not of that form. */
function parseGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) return null;
  return [m[1], m[2]];
}

/** `@@ -A[,B] +C[,D] @@`: the old start A, or null when the line is not a hunk header. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/** The path a `--- ` or `+++ ` header line names: after the four characters, up to the first tab, spaces removed, a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  const p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A hunk body's kind, or null when the line is not a body line. */
function bodyKind(line: string): string | null {
  if (line === '') return ' ';
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return c;
  return null;
}

/** O is the hunk's context and `-` lines, N its context and `+` lines, each in body order. */
function hunkON(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j].kind === ' ' || h.body[j].kind === '+') last = j;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1].kind === '\\';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  let mode: 'out' | 'header' | 'body' | 'between' = 'out';

  const newSection = (git: [string, string] | null): void => {
    if (hunk !== null) {
      trimBody(hunk);
      if (cur !== null) cur.hunks.push(hunk);
      hunk = null;
    }
    cur = {
      gitOld: git === null ? null : git[0],
      gitNew: git === null ? null : git[1],
      pairOld: null,
      pairNew: null,
      hasPairOld: false,
      hasPairNew: false,
      renFrom: null,
      renTo: null,
      create: false,
      del: false,
      hunks: [],
    };
    sections.push(cur);
    mode = 'header';
  };

  const setPair = (i: number): void => {
    if (cur === null) return;
    cur.pairOld = headerPath(lines[i]);
    cur.pairNew = headerPath(lines[i + 1]);
    cur.hasPairOld = true;
    cur.hasPairNew = true;
  };

  const startHunk = (i: number): void => {
    const a = parseHunkHeader(lines[i]);
    if (a === null) throw new Exit2(`error: parse ${i + 1}`);
    if (hunk !== null) {
      trimBody(hunk);
      if (cur !== null) cur.hunks.push(hunk);
    }
    hunk = { a, body: [] };
    mode = 'body';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (mode === 'body') {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(g);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSection(null);
        setPair(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        startHunk(i);
        i++;
      } else {
        const k = bodyKind(line);
        if (k === null) {
          if (hunk !== null) {
            trimBody(hunk);
            if (cur !== null) cur.hunks.push(hunk);
            hunk = null;
          }
          mode = 'between';
        } else {
          hunk!.body.push({ kind: k, text: k === '\\' ? line : line.slice(1), raw: line });
          i++;
        }
      }
    } else if (mode === 'header') {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(g);
        i++;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur !== null && cur.hasPairOld) {
            newSection(null);
            setPair(i);
          } else {
            setPair(i);
          }
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        if (cur !== null) {
          cur.pairNew = headerPath(line);
          cur.hasPairNew = true;
        }
        i++;
      } else if (line.startsWith('@@')) {
        startHunk(i);
        i++;
      } else if (line.startsWith('rename from ')) {
        if (cur !== null) cur.renFrom = line.slice(12);
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur !== null) cur.renTo = line.slice(10);
        i++;
      } else if (line.startsWith('new file mode')) {
        if (cur !== null) cur.create = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        if (cur !== null) cur.del = true;
        i++;
      } else {
        i++;
      }
    } else if (mode === 'between') {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(g);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSection(null);
        setPair(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        startHunk(i);
        i++;
      } else {
        i++;
      }
    } else {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        newSection(g);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSection(null);
        setPair(i);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    }
  }
  if (hunk !== null) {
    trimBody(hunk);
    if (cur !== null) cur.hunks.push(hunk);
    hunk = null;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Empty lines at the end of a hunk body are not part of it. */
function trimBody(h: Hunk): void {
  while (h.body.length > 0 && h.body[h.body.length - 1].raw === '') h.body.pop();
}

/** One unified section as one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const rawOld = sec.hasPairOld ? sec.pairOld : sec.renFrom ?? sec.gitOld;
  const rawNew = sec.hasPairNew ? sec.pairNew : sec.renTo ?? sec.gitNew;
  const oldPath = rawOld === null || rawOld === '/dev/null' ? null : rawOld;
  const newPath = rawNew === null || rawNew === '/dev/null' ? null : rawNew;
  const isCreate = sec.create || oldPath === null;
  const isDelete = sec.del || newPath === null;
  return (tree: Tree): MovePair[] => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate && newPath !== null) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let endsWithBreak = true;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') plus.push(b.text);
        }
      }
      if (sec.hunks.length > 0) {
        const lastHunk = sec.hunks[sec.hunks.length - 1];
        endsWithBreak = !backslashAfterLast(lastHunk);
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
      return [];
    }
    if (isDelete && oldPath !== null) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return [];
    }
    if (oldPath === null || newPath === null) return [];
    const isMove = oldPath !== newPath;
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const doc = parseDoc(text);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = hunkON(h);
      if (o.length === 0) {
        const at = Math.min(h.a + d, doc.lines.length);
        const inserted = n.map((x) => x.text);
        if (at === doc.lines.length) doc.final = !backslashAfterLast(h);
        doc.lines.splice(at, 0, ...inserted);
        d += n.length;
      } else {
        const m = matchFrom(doc.lines, o, strict, 0);
        if (m === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let best = m.occ[0];
        let bestDist = Math.abs(best - target);
        for (const p of m.occ) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        if (best + o.length === doc.lines.length) doc.final = !backslashAfterLast(h);
        const rep = buildReplacement(doc.lines, best, o, n, m.tier);
        doc.lines.splice(best, o.length, ...rep);
        d += n.length - o.length;
      }
    }
    const out = renderDoc(doc);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      return [[oldPath, newPath]];
    }
    tree.now.set(oldPath, out);
    return [];
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): MovePair[] => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return [];
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const m = matchFrom(doc.lines, oldLines, strict, 0);
    if (m === null) throw new Fail('no-match', path);
    if (m.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = m.occ[0];
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildReplacement(doc.lines, pos, oldLines, n, m.tier);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderDoc(doc));
    return [];
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aLine {
  text: string;
  no: number;
}

interface Chunk {
  anchor: string;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    let kind = '';
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateNo = i + 1;
    const secLines: V4aLine[] = [];
    i++;
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, no: i + 1 });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1].text)) secLines.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, secLines));
    else if (kind === 'delete') edits.push(v4aDeleteEdit(path, secLines));
    else edits.push(v4aUpdateEdit(path, secLines, updateNo, strict));
  }
  return edits;
}

function v4aAddEdit(path: string, secLines: V4aLine[]): Edit {
  const fileLines: string[] = [];
  for (const l of secLines) {
    if (l.text === '') fileLines.push('');
    else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
    else throw new Exit2(`error: parse ${l.no}`);
  }
  return (tree: Tree): MovePair[] => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return [];
  };
}

function v4aDeleteEdit(path: string, secLines: V4aLine[]): Edit {
  if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0].no}`);
  return (tree: Tree): MovePair[] => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    return [];
  };
}

function v4aUpdateEdit(path: string, secLines: V4aLine[], updateNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let rest = secLines;
  if (rest.length > 0 && rest[0].text.startsWith('*** Move to: ')) {
    moveTo = rest[0].text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const l of rest) {
    const t = l.text;
    if (t.startsWith('@@')) {
      cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
    } else if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.no}`);
      cur.eof = true;
      cur = null;
    } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: '', eof: false, body: [] };
          chunks.push(cur);
        } else {
          throw new Exit2(`error: parse ${l.no}`);
        }
      }
      cur.body.push({ kind: t === '' ? ' ' : t[0], text: t === '' ? '' : t.slice(1), raw: t });
    } else {
      throw new Exit2(`error: parse ${l.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
  return (tree: Tree): MovePair[] => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const at = matchSingleLine(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = hunkON({ a: 0, body: ch.body });
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const inserted = n.map((x) => x.text);
        doc.lines.splice(at, 0, ...inserted);
        cursor = at + inserted.length;
      } else {
        const m = matchFrom(doc.lines, o, strict, cursor);
        if (m === null) throw new Fail('no-match', path);
        let pos: number | null = null;
        if (ch.eof) {
          for (const p of m.occ) {
            if (p + o.length === doc.lines.length) {
              pos = p;
              break;
            }
          }
          if (pos === null) throw new Fail('no-match', path);
        } else {
          pos = m.occ[0];
        }
        const rep = buildReplacement(doc.lines, pos, o, n, m.tier);
        doc.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return [[path, moveTo]];
    }
    tree.now.set(path, out);
    return [];
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: the command line, the output and the all-or-nothing write.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: MovePair[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      moves.push(...edit(tree));
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byKey = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const movedOld = new Set<string>();
  const movedNew = new Map<string, string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      movedOld.add(o);
      movedNew.set(n, o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byKey)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moves) {
    if (movedOld.has(o) && movedNew.get(n) === o) rows.push({ key: n, line: `R ${o} -> ${n}` });
  }
  rows.sort((a, b) => byKey(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byKey)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
