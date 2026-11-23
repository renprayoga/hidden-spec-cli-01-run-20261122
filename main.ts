// mend — a command-line patch applier.
//
// Usage: node main.ts [--format=auto|unified|search-replace|v4a|json]
//                     [--check] [--strict] [--] [PATCH]
//
// A patch file (or stdin when PATCH is `-` or absent) holds edits in one of
// four shapes: unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON tool
// calls. Each edit is located by trying three increasingly forgiving ways of
// matching its old text, then applied to an in-memory copy of the file tree.
// Only when every edit succeeds are the changed files written back to disk;
// a single failure leaves the tree untouched. Edits are also applied in
// order, so a later edit sees the result of an earlier one — but a failure
// rolls back only the failing edit, not the ones before it.
//
// This program uses nothing beyond the Node 22 standard library, and only
// TypeScript syntax that Node's type stripping can erase (no enums, no
// namespaces, no parameter properties).
//
// When MAKEFUN_ENV_URL is set, the bottom of this file hands control to
// runner.ts instead of running the CLI; that hand-over must stay as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Outcomes: how a run can end.
// ---------------------------------------------------------------------------

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A malformed patch: the process exits 2 printing just this line. */
class PatchError {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that could not be applied: its reason code and the file it hit. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** One edit: mutate the tree, or throw an EditFailure; return any moves made. */
type Move = [string, string];
type EditFn = (tree: WorkTree) => Move[];

// ---------------------------------------------------------------------------
// Small string helpers.
// ---------------------------------------------------------------------------

const isBlank = (s: string): boolean => s.trim() === '';

/** Split patch text into lines: `\n`-separated, one trailing `\r` stripped per line, no empty tail after a final newline. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is non-empty, relative, backslash-free, and none of its slash-separated pieces is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function indentOf(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

// ---------------------------------------------------------------------------
// A text file as lines: its line break, its lines, whether it ends with one.
// ---------------------------------------------------------------------------

interface Doc {
  br: string;
  lines: string[];
  final: boolean;
}

function readDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

// ---------------------------------------------------------------------------
// The working tree: original contents read lazily from disk, edits in `now`.
// ---------------------------------------------------------------------------

class WorkTree {
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

// ---------------------------------------------------------------------------
// Matching: three tiers of forgiveness when finding old text in a file.
// ---------------------------------------------------------------------------

/** A line as seen at a tier: 0 exact, 1 trailing whitespace ignored, 2 both ends ignored. */
function tiered(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimRightWs(s);
  return trimWs(s);
}

/** Every position at or after `from` where `old` matches `lines` at this tier. */
function findOccurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const first = tiered(old[0], tier);
  const rest = old.slice(1).map((l) => tiered(l, tier));
  for (let i = from; i + old.length <= lines.length; i++) {
    if (tiered(lines[i], tier) !== first) continue;
    let ok = true;
    for (let j = 0; j < rest.length; j++) {
      if (tiered(lines[i + 1 + j], tier) !== rest[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (exact, then trailing-trimmed, then fully trimmed) at which `old` occurs at or after `from`; null when it never does. In strict mode only tier 0 is tried. */
function findMatch(lines: string[], old: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `want`, at the first tier where one exists. */
function findLine(lines: string[], want: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const nw = tiered(want, t);
    for (let i = from; i < lines.length; i++) {
      if (tiered(lines[i], t) === nw) return i;
    }
  }
  return null;
}

/** At tier 2 a replacement line keeps the file's indentation: the old block's leading whitespace is swapped for the matched lines' own. Blank lines are left alone. */
function reindent(line: string, oldIndent: string, fileIndent: string): string {
  if (line === '' || line.trim() === '') return line;
  if (oldIndent !== '' && !line.startsWith(oldIndent)) return line;
  return fileIndent + line.slice(oldIndent.length);
}

/** One replacement line: its text, plus the index of the old line it copies verbatim from the file (a context line), or -1. */
interface ReplacementLine {
  text: string;
  ctx: number;
}

/** The lines that take the place of the matched block: context lines come from the file itself, the rest are re-indented only at tier 2. */
function buildNewLines(fileLines: string[], pos: number, old: string[], replacement: ReplacementLine[], tier: number): string[] {
  const out: string[] = [];
  const oldIndent = old.length > 0 ? indentOf(old[0]) : '';
  const fileIndent = pos < fileLines.length ? indentOf(fileLines[pos]) : '';
  for (const nl of replacement) {
    if (nl.ctx >= 0) out.push(fileLines[pos + nl.ctx]);
    else if (tier === 2) out.push(reindent(nl.text, oldIndent, fileIndent));
    else out.push(nl.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which format is this patch?
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches.
// ---------------------------------------------------------------------------

/** One numbered line of a V4A file section, kept with its 1-based line number for error reports. */
interface PatchLine {
  text: string;
  no: number;
}

/** One `@@` chunk of a V4A update: its anchor line, whether it runs to end of file, and its body lines. */
interface Chunk {
  anchor: string;
  eof: boolean;
  body: DiffLine[];
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchError('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new PatchError(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new PatchError(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
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
      throw new PatchError(`error: parse ${i + 1}`);
    }
    const updateNo = i + 1;
    const secLines: PatchLine[] = [];
    i++;
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, no: i + 1 });
      i++;
    }
    while (secLines.length > 0 && isBlank(secLines[secLines.length - 1].text)) secLines.pop();
    if (kind === 'add') edits.push(v4aAdd(path, secLines));
    else if (kind === 'delete') edits.push(v4aDelete(path, secLines));
    else edits.push(v4aUpdate(path, secLines, updateNo, strict));
  }
  return edits;
}

function v4aAdd(path: string, secLines: PatchLine[]): EditFn {
  const fileLines: string[] = [];
  for (const l of secLines) {
    if (l.text === '') fileLines.push('');
    else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
    else throw new PatchError(`error: parse ${l.no}`);
  }
  return (tree: WorkTree): Move[] => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return [];
  };
}

function v4aDelete(path: string, secLines: PatchLine[]): EditFn {
  if (secLines.length > 0) throw new PatchError(`error: parse ${secLines[0].no}`);
  return (tree: WorkTree): Move[] => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.now.set(path, null);
    return [];
  };
}

function v4aUpdate(path: string, secLines: PatchLine[], updateNo: number, strict: boolean): EditFn {
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
      if (cur === null) throw new PatchError(`error: parse ${l.no}`);
      cur.eof = true;
      cur = null;
    } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: '', eof: false, body: [] };
          chunks.push(cur);
        } else {
          throw new PatchError(`error: parse ${l.no}`);
        }
      }
      cur.body.push({ kind: t === '' ? ' ' : t[0], text: t === '' ? '' : t.slice(1), raw: t });
    } else {
      throw new PatchError(`error: parse ${l.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new PatchError(`error: parse ${updateNo}`);
  return (tree: WorkTree): Move[] => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const doc = readDoc(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const at = findLine(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new EditFailure('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitHunk({ a: 0, body: ch.body });
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const inserted = n.map((x) => x.text);
        doc.lines.splice(at, 0, ...inserted);
        cursor = at + inserted.length;
      } else {
        const m = findMatch(doc.lines, o, strict, cursor);
        if (m === null) throw new EditFailure('no-match', path);
        let pos: number | null = null;
        if (ch.eof) {
          for (const p of m.occ) {
            if (p + o.length === doc.lines.length) {
              pos = p;
              break;
            }
          }
          if (pos === null) throw new EditFailure('no-match', path);
        } else {
          pos = m.occ[0];
        }
        const rep = buildNewLines(doc.lines, pos, o, n, m.tier);
        doc.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = writeDoc(doc);
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
// JSON tool-call edits.
// ---------------------------------------------------------------------------

/** Turn one JSON edit object into an edit, or null when the object is not a valid edit. */
function jsonToEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: WorkTree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
      return [];
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return [];
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new EditFailure('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return [];
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchError('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new PatchError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new PatchError(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonToEdit(x);
      if (e === null) throw new PatchError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonToEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new PatchError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs.
// ---------------------------------------------------------------------------

/** One line of a hunk body: its kind (` ` context, `-` old, `+` new, `\` no-newline marker), its text without the marker, and the raw line. */
interface DiffLine {
  kind: string;
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: DiffLine[];
}

interface DiffSection {
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

/** `diff --git a/<X> b/<Y>` split into its two paths, or null when the line is not of that form. */
function gitHeader(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) return null;
  return [m[1], m[2]];
}

/** The old start line of a `@@ -A[,B] +C[,D] @@` header, or null when the line is not one. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/** The path a `--- ` or `+++ ` header names: after the four characters, up to the first tab, trimmed, with a leading `a/` or `b/` removed. */
function diffPath(line: string): string {
  const p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A hunk body's kind for this line, or null when the line cannot be a body line. */
function bodyMark(line: string): string | null {
  if (line === '') return ' ';
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return c;
  return null;
}

/** A hunk split into its old lines O (context plus `-`) and its new lines N (context plus `+`), in body order. Context lines remember which O line they copy. */
function splitHunk(h: Hunk): { o: string[]; n: ReplacementLine[] } {
  const o: string[] = [];
  const n: ReplacementLine[] = [];
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

/** Whether a `\` line follows the hunk's last context or `+` line — that is, whether the new file does not end with a line break. */
function noNewlineAtEnd(h: Hunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j].kind === ' ' || h.body[j].kind === '+') last = j;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1].kind === '\\';
}

/** Trailing empty lines are not part of a hunk body. */
function dropTrailingBlanks(h: Hunk): void {
  while (h.body.length > 0 && h.body[h.body.length - 1].raw === '') h.body.pop();
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let hunk: Hunk | null = null;
  let mode: 'out' | 'header' | 'body' | 'between' = 'out';

  const openSection = (git: [string, string] | null): void => {
    if (hunk !== null) {
      dropTrailingBlanks(hunk);
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
    cur.pairOld = diffPath(lines[i]);
    cur.pairNew = diffPath(lines[i + 1]);
    cur.hasPairOld = true;
    cur.hasPairNew = true;
  };

  const openHunk = (i: number): void => {
    const a = hunkStart(lines[i]);
    if (a === null) throw new PatchError(`error: parse ${i + 1}`);
    if (hunk !== null) {
      dropTrailingBlanks(hunk);
      if (cur !== null) cur.hunks.push(hunk);
    }
    hunk = { a, body: [] };
    mode = 'body';
  };

  /** A `diff --git ...` line: open its section, or report a parse error. Returns false when the line is not one. */
  const gitLine = (i: number): boolean => {
    if (!lines[i].startsWith('diff --git ')) return false;
    const g = gitHeader(lines[i]);
    if (g === null) throw new PatchError(`error: parse ${i + 1}`);
    openSection(g);
    return true;
  };

  /** A `--- ` line followed by `+++ `: open a section (or set the pair) and consume both lines. Returns false when the line is not one. */
  const pairLine = (i: number): boolean => {
    if (!lines[i].startsWith('--- ') || !(lines[i + 1] ?? '').startsWith('+++ ')) return false;
    openSection(null);
    setPair(i);
    return true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (mode === 'body') {
      if (gitLine(i)) {
        i++;
      } else if (pairLine(i)) {
        i += 2;
      } else if (line.startsWith('@@')) {
        openHunk(i);
        i++;
      } else {
        const k = bodyMark(line);
        if (k === null) {
          if (hunk !== null) {
            dropTrailingBlanks(hunk);
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
      if (gitLine(i)) {
        i++;
      } else if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur !== null && cur.hasPairOld) {
            openSection(null);
            setPair(i);
          } else {
            setPair(i);
          }
          i += 2;
        } else {
          throw new PatchError(`error: parse ${i + 2}`);
        }
      } else if (line.startsWith('+++ ')) {
        if (cur !== null) {
          cur.pairNew = diffPath(line);
          cur.hasPairNew = true;
        }
        i++;
      } else if (line.startsWith('@@')) {
        openHunk(i);
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
      if (gitLine(i)) {
        i++;
      } else if (pairLine(i)) {
        i += 2;
      } else if (line.startsWith('@@')) {
        openHunk(i);
        i++;
      } else {
        i++;
      }
    } else {
      if (gitLine(i)) {
        i++;
      } else if (pairLine(i)) {
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new PatchError(`error: parse ${i + 1}`);
      } else {
        i++;
      }
    }
  }
  if (hunk !== null) {
    dropTrailingBlanks(hunk);
    if (cur !== null) cur.hunks.push(hunk);
    hunk = null;
  }
  return sections.map((s) => unifiedToEdit(s, strict));
}

/** One unified-diff section as one edit. */
function unifiedToEdit(sec: DiffSection, strict: boolean): EditFn {
  const rawOld = sec.hasPairOld ? sec.pairOld : sec.renFrom ?? sec.gitOld;
  const rawNew = sec.hasPairNew ? sec.pairNew : sec.renTo ?? sec.gitNew;
  const oldPath = rawOld === null || rawOld === '/dev/null' ? null : rawOld;
  const newPath = rawNew === null || rawNew === '/dev/null' ? null : rawNew;
  const isCreate = sec.create || oldPath === null;
  const isDelete = sec.del || newPath === null;
  return (tree: WorkTree): Move[] => {
    if (oldPath !== null && !isSafePath(oldPath)) throw new EditFailure('unsafe', oldPath);
    if (newPath !== null && !isSafePath(newPath)) throw new EditFailure('unsafe', newPath);
    if (isCreate && newPath !== null) {
      if (tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
      const plus: string[] = [];
      let endsWithBreak = true;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') plus.push(b.text);
        }
      }
      if (sec.hunks.length > 0) {
        const lastHunk = sec.hunks[sec.hunks.length - 1];
        endsWithBreak = !noNewlineAtEnd(lastHunk);
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
      return [];
    }
    if (isDelete && oldPath !== null) {
      if (tree.get(oldPath) === null) throw new EditFailure('missing', oldPath);
      tree.now.set(oldPath, null);
      return [];
    }
    if (oldPath === null || newPath === null) return [];
    const isMove = oldPath !== newPath;
    const text = tree.get(oldPath);
    if (text === null) throw new EditFailure('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
    const doc = readDoc(text);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = splitHunk(h);
      if (o.length === 0) {
        const at = Math.min(h.a + d, doc.lines.length);
        const inserted = n.map((x) => x.text);
        if (at === doc.lines.length) doc.final = !noNewlineAtEnd(h);
        doc.lines.splice(at, 0, ...inserted);
        d += n.length;
      } else {
        const m = findMatch(doc.lines, o, strict, 0);
        if (m === null) throw new EditFailure('no-match', oldPath);
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
        if (best + o.length === doc.lines.length) doc.final = !noNewlineAtEnd(h);
        const rep = buildNewLines(doc.lines, best, o, n, m.tier);
        doc.lines.splice(best, o.length, ...rep);
        d += n.length - o.length;
      }
    }
    const out = writeDoc(doc);
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
// SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
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
      if (prevPath === null) throw new PatchError(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new PatchError(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new PatchError(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srToEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srToEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree: WorkTree): Move[] => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return [];
    }
    const text = tree.get(path);
    if (text === null) throw new EditFailure('missing', path);
    const doc = readDoc(text);
    const m = findMatch(doc.lines, oldLines, strict, 0);
    if (m === null) throw new EditFailure('no-match', path);
    if (m.occ.length > 1) throw new EditFailure('ambiguous', path);
    const pos = m.occ[0];
    const n: ReplacementLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildNewLines(doc.lines, pos, oldLines, n, m.tier);
    doc.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, writeDoc(doc));
    return [];
  };
}

// ---------------------------------------------------------------------------
// The command line, the run, and the all-or-nothing write-back.
// ---------------------------------------------------------------------------

/** Compare two paths the way the output rows are ordered: by UTF-8 bytes. */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice(9))) format = a.slice(9);
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
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new PatchError('error: parse 1');
  } catch (e) {
    if (e instanceof PatchError) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      moves.push(...edit(tree));
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedOld = new Set<string>();
  const movedNew = new Map<string, string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      movedOld.add(o);
      movedNew.set(n, o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moves) {
    if (movedOld.has(o) && movedNew.get(n) === o) rows.push({ key: n, line: `R ${o} -> ${n}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byBytes)) {
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
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
