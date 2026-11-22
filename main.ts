// mend: one patch tool for every AI edit format.
//
// A patch comes in as a unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, or JSON edit objects. This file reads the patch, works out which
// edits it asks for, and applies them to the tree in the working directory:
// every file changes, or nothing does. The rules it follows are the ones in
// SPEC.md, which sits beside this file. Only the Node standard library is
// used, and the file runs under `node main.ts`.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A path is safe when it stays inside the tree: relative, no backslash, and
 *  no empty, `.` or `..` segment. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripEdgeWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Split patch text into lines: split at `\n`, drop one trailing `\r` per
 *  line, and drop the empty piece after a final `\n`. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A line is blank when it is empty or only whitespace. */
const isBlank = (l: string): boolean => l.trim() === '';

// ---------------------------------------------------------------------------
// One file, as lines
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  eol: '\n' | '\r\n';
  ends: boolean; // the file ends with its line break
}

/** Read a file's text into lines. The break is CRLF when the first line feed
 *  follows a carriage return, LF otherwise. An empty file has no lines. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let ends = false;
  if (text.endsWith(eol)) {
    ends = true;
    parts.pop();
  }
  return { lines: parts, eol, ends };
}

/** Write a file's lines back out. A file with no lines is written empty. */
function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.eol) + (s.ends ? s.eol : '');
}

// ---------------------------------------------------------------------------
// The tree, in memory
// ---------------------------------------------------------------------------

/** The tree as the patch leaves it, with the disk state remembered so the
 *  final report can say what changed. `null` means the path holds no file. */
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  /** The file's current text, or null when there is no file there now. */
  current(path: string): string | null {
    if (!this.orig.has(path)) {
      let text: string | null = null;
      try {
        if (statSync(path).isFile()) text = readFileSync(path, 'utf8');
      } catch {
        text = null;
      }
      this.orig.set(path, text);
      this.cur.set(path, text);
    }
    return this.cur.get(path) ?? null;
  }

  /** Whether a file stands at the path in the tree as it now is. A directory
   *  on disk counts as standing there too, since no file can be created
   *  over it. */
  stands(path: string): boolean {
    if (this.cur.has(path)) return this.cur.get(path) !== null;
    return existsSync(path);
  }

  set(path: string, text: string | null): void {
    if (!this.orig.has(path)) void this.current(path);
    this.cur.set(path, text);
  }

  /** Every path an edit touched, with its before and after text. */
  touched(): Array<[string, string | null, string | null]> {
    const out: Array<[string, string | null, string | null]> = [];
    for (const [p, after] of this.cur) out.push([p, this.orig.get(p) ?? null, after]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Matching lines
// ---------------------------------------------------------------------------

/** Do a file line and an old line agree at a tier? Tier 0 is exact, tier 1
 *  ignores trailing spaces and tabs, tier 2 ignores them on both ends. */
function linesAgree(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return stripTrailingWs(fileLine) === stripTrailingWs(oldLine);
  return stripEdgeWs(fileLine) === stripEdgeWs(oldLine);
}

/** Every 0-based position where the old lines occur, overlaps included. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  if (old.length === 0) return found;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!linesAgree(lines[i + j], old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (of the ones allowed) at which the old lines occur at
 *  least once, with every occurrence at that tier. */
function firstTierWith(lines: string[], old: string[], tiers: number[]): { tier: number; at: number[] } | null {
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building the replacement lines
// ---------------------------------------------------------------------------

/** One line of an old or new block: its text, and whether it is a context
 *  line (one the old and new blocks share). */
interface BlockLine {
  text: string;
  context: boolean;
}

/** Turn a new block into the lines that are written. A context line is
 *  written as the file's own matched line; any other line is written as it
 *  is, except at tier 2, where a non-blank line that starts with the old
 *  block's first-line indent has that indent swapped for the file's. */
function buildNewLines(oldBlock: BlockLine[], newBlock: BlockLine[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const fileContext: string[] = [];
  for (let j = 0; j < oldBlock.length; j++) {
    if (oldBlock[j].context) fileContext.push(fileLines[pos + j]);
  }
  const fileIndent = tier === 2 ? leadingWs(fileLines[pos]) : '';
  const oldIndent = tier === 2 ? leadingWs(oldBlock[0].text) : '';
  let taken = 0;
  for (const line of newBlock) {
    if (line.context) {
      out.push(fileContext[taken]);
      taken += 1;
    } else {
      let text = line.text;
      if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(oldIndent)) {
        text = fileIndent + text.slice(oldIndent.length);
      }
      out.push(text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** A change to a file's text: the new text, or the failure code. */
type Transform = (text: string) => { text: string } | { fail: string };

type Edit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'change'; path: string; transform: Transform }
  | { kind: 'move'; oldPath: string; newPath: string; transform: Transform };

/** The paths an edit names, in the order they appear, for the safety check. */
function editPaths(e: Edit): string[] {
  if (e.kind === 'move') return [e.oldPath, e.newPath];
  return [e.path];
}

interface EditOutcome {
  fail?: { code: string; path: string };
  move?: { old: string; next: string };
}

/** Apply one edit to the tree. A failed edit changes nothing. */
function applyEdit(tree: Tree, e: Edit): EditOutcome {
  for (const p of editPaths(e)) {
    if (!isSafePath(p)) return { fail: { code: 'unsafe', path: p } };
  }
  if (e.kind === 'create') {
    if (tree.stands(e.path)) return { fail: { code: 'exists', path: e.path } };
    tree.set(e.path, e.text);
    return {};
  }
  if (e.kind === 'delete') {
    if (tree.current(e.path) === null) return { fail: { code: 'missing', path: e.path } };
    tree.set(e.path, null);
    return {};
  }
  if (e.kind === 'change') {
    const now = tree.current(e.path);
    if (now === null) return { fail: { code: 'missing', path: e.path } };
    const r = e.transform(now);
    if ('fail' in r) return { fail: { code: r.fail, path: e.path } };
    tree.set(e.path, r.text);
    return {};
  }
  const now = tree.current(e.oldPath);
  if (now === null) return { fail: { code: 'missing', path: e.oldPath } };
  if (tree.stands(e.newPath)) return { fail: { code: 'exists', path: e.newPath } };
  const r = e.transform(now);
  if ('fail' in r) return { fail: { code: r.fail, path: e.oldPath } };
  tree.set(e.oldPath, null);
  tree.set(e.newPath, r.text);
  return { move: { old: e.oldPath, next: e.newPath } };
}

// ---------------------------------------------------------------------------
// Parsing: shared pieces
// ---------------------------------------------------------------------------

/** A parse fault carries the 1-based patch line to report. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** A hunk or chunk body line: what it starts with, and the text after it.
 *  An empty line is a context line with empty text. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function bodyLineOf(line: string): BodyLine | null {
  if (line === '') return { kind: ' ', text: '' };
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return { kind: c, text: line.slice(1) };
  return null;
}

/** Split a body into its old block (context and `-` lines) and its new
 *  block (context and `+` lines), in body order. */
function splitBody(body: BodyLine[]): { oldBlock: BlockLine[]; newBlock: BlockLine[] } {
  const oldBlock: BlockLine[] = [];
  const newBlock: BlockLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      oldBlock.push({ text: b.text, context: true });
      newBlock.push({ text: b.text, context: true });
    } else if (b.kind === '-') {
      oldBlock.push({ text: b.text, context: false });
    } else if (b.kind === '+') {
      newBlock.push({ text: b.text, context: false });
    }
  }
  return { oldBlock, newBlock };
}

/** Does a `\` line follow the body's last context or `+` line? That is what
 *  decides whether a result that runs to the file's end keeps its final
 *  line break. */
function backslashAfterLastAdded(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === ' ' || body[i].kind === '+') last = i;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === '\\';
}

// ---------------------------------------------------------------------------
// Parsing: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  oldStart: number;
  body: BodyLine[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** Strip a leading `a/` or `b/` from a `---`/`+++` path. */
function unprefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Split a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): { old: string; next: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const old = rest.slice(2, sep);
  const next = rest.slice(sep + 3);
  if (old === '' || next === '') return null;
  return { old, next };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const freshSection = (): UnifiedSection => ({
    gitOld: null,
    gitNew: null,
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const paths = gitPaths(line);
      if (paths === null) throw new ParseFault(i + 1);
      cur = freshSection();
      cur.gitOld = paths.old;
      cur.gitNew = paths.next;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (cur !== null && inHeader && cur.oldPath === null) {
        if (next === undefined || !next.startsWith('+++ ')) throw new ParseFault(i + 2);
        cur.oldPath = unprefix(headerPath(line));
        cur.newPath = unprefix(headerPath(next));
        i += 2;
        continue;
      }
      if (next !== undefined && next.startsWith('+++ ')) {
        cur = freshSection();
        cur.oldPath = unprefix(headerPath(line));
        cur.newPath = unprefix(headerPath(next));
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.newPath === null) cur.newPath = unprefix(headerPath(line));
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      const oldStart = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) break;
        const parsed = bodyLineOf(bl);
        if (parsed === null) break;
        body.push(parsed);
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();
      cur.hunks.push({ oldStart, body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const old = s.oldPath ?? s.renameFrom ?? s.gitOld;
    const next = s.newPath ?? s.renameTo ?? s.gitNew;
    if (old === null || next === null) continue;
    if (old === '/dev/null' || s.newFile) {
      const added: string[] = [];
      let lastPlus: { hunk: Hunk; at: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((b, at) => {
          if (b.kind === '+') {
            added.push(b.text);
            lastPlus = { hunk: h, at };
          }
        });
      }
      let text = added.length === 0 ? '' : `${added.join('\n')}\n`;
      if (lastPlus !== null) {
        const after = lastPlus.hunk.body[lastPlus.at + 1];
        if (after !== undefined && after.kind === '\\') text = added.join('\n');
      }
      edits.push({ kind: 'create', path: next, text });
      continue;
    }
    if (next === '/dev/null' || s.deletedFile) {
      edits.push({ kind: 'delete', path: old });
      continue;
    }
    const transform = unifiedTransform(s.hunks, strict);
    if (old !== next) edits.push({ kind: 'move', oldPath: old, newPath: next, transform });
    else edits.push({ kind: 'change', path: old, transform });
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

/** The hunks of one section, applied in order to a file's text. */
function unifiedTransform(hunks: Hunk[], strict: boolean): Transform {
  return (text: string) => {
    const state = parseFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    let lines = [...state.lines];
    let ends = state.ends;
    let d = 0;
    for (const h of hunks) {
      const { oldBlock, newBlock } = splitBody(h.body);
      const noEol = backslashAfterLastAdded(h.body);
      if (oldBlock.length === 0) {
        const at = Math.min(Math.max(h.oldStart + d, 0), lines.length);
        const wasEnd = at === lines.length;
        const inserted = newBlock.map((l) => l.text);
        lines.splice(at, 0, ...inserted);
        if (wasEnd && inserted.length > 0) ends = !noEol;
        d += newBlock.length;
        continue;
      }
      const found = firstTierWith(lines, oldBlock.map((l) => l.text), tiers);
      if (found === null) return { fail: 'no-match' };
      const target = h.oldStart - 1 + d;
      let pos = found.at[0];
      let best = Math.abs(pos - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          pos = p;
          best = dist;
        }
      }
      const replacement = buildNewLines(oldBlock, newBlock, lines, pos, found.tier);
      const atEnd = pos + oldBlock.length === lines.length;
      lines.splice(pos, oldBlock.length, ...replacement);
      if (atEnd) ends = !noEol;
      d += newBlock.length - oldBlock.length;
    }
    return { text: renderFile({ lines, eol: state.eol, ends }) };
  };
}

// ---------------------------------------------------------------------------
// Parsing: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let lastPath: string | null = null;
  let afterPrev = 0;
  let i = 0;
  while (i < lines.length) {
    const s = lines.findIndex((l, at) => at >= i && stripTrailingWs(l) === '<<<<<<< SEARCH');
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= afterPrev; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new ParseFault(s + 1);
      path = lastPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = stripTrailingWs(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new ParseFault(s + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = stripTrailingWs(lines[j]);
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new ParseFault(s + 1);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    lastPath = path;
    afterPrev = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);

  return blocks.map((b) => {
    if (b.oldLines.length === 0) {
      const text = b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`;
      return { kind: 'create', path: b.path, text } as Edit;
    }
    const transform: Transform = (text: string) => {
      const state = parseFile(text);
      const found = firstTierWith(state.lines, b.oldLines, strict ? [0] : [0, 1, 2]);
      if (found === null) return { fail: 'no-match' };
      if (found.at.length > 1) return { fail: 'ambiguous' };
      const pos = found.at[0];
      const oldBlock = b.oldLines.map((t) => ({ text: t, context: false }));
      const newBlock = b.newLines.map((t) => ({ text: t, context: false }));
      const replacement = buildNewLines(oldBlock, newBlock, state.lines, pos, found.tier);
      const lines = [...state.lines];
      lines.splice(pos, b.oldLines.length, ...replacement);
      return { text: renderFile({ lines, eol: state.eol, ends: state.ends }) };
    };
    return { kind: 'change', path: b.path, transform } as Edit;
  });
}

// ---------------------------------------------------------------------------
// Parsing: V4A patches
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
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
      throw new ParseFault(i + 1);
    }
    i += 1;
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1])) raw.pop();
    const sectionStart = i - raw.length; // 0-based index of raw[0] in lines
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseFault(sectionStart + k + 1);
      }
      sections.push({ kind: 'add', path, lines: fileLines });
      continue;
    }
    if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!isBlank(raw[k])) throw new ParseFault(sectionStart + k + 1);
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    sections.push(parseV4aUpdate(path, raw, sectionStart));
  }
  if (sections.length === 0) throw new ParseFault(1);

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const text = s.lines.length === 0 ? '' : `${s.lines.join('\n')}\n`;
      edits.push({ kind: 'create', path: s.path, text });
    } else if (s.kind === 'delete') {
      edits.push({ kind: 'delete', path: s.path });
    } else {
      const transform = v4aTransform(s.chunks, strict);
      if (s.moveTo !== null) edits.push({ kind: 'move', oldPath: s.path, newPath: s.moveTo, transform });
      else edits.push({ kind: 'change', path: s.path, transform });
    }
  }
  return edits;
}

/** Parse the lines of an Update File section. `base` is the 0-based index
 *  of the section's first line, so faults can name their patch line. */
function parseV4aUpdate(path: string, raw: string[], base: number): V4aSection {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.length > 0 && raw[0].startsWith('*** Move to: ')) {
    moveTo = raw[0].slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let closedByEof = false;
  for (let k = start; k < raw.length; k++) {
    const l = raw[k];
    const lineNo = base + k + 1;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      closedByEof = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new ParseFault(lineNo);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      closedByEof = true;
      continue;
    }
    const parsed = bodyLineOf(l);
    if (parsed === null) throw new ParseFault(lineNo);
    if (cur === null) {
      if (chunks.length === 0 && !closedByEof) {
        cur = { anchor: null, eof: false, body: [] };
      } else {
        throw new ParseFault(lineNo);
      }
    }
    cur.body.push(parsed);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) {
    // The Update File line sits one line before the section's first line.
    throw new ParseFault(base);
  }
  return { kind: 'update', path, moveTo, chunks };
}

/** The chunks of one Update File section, applied in order, with the
 *  cursor walking down the file. */
function v4aTransform(chunks: V4aChunk[], strict: boolean): Transform {
  return (text: string) => {
    const state = parseFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    let lines = [...state.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const tier of tiers) {
          for (let i = cursor; i < lines.length; i++) {
            if (linesAgree(lines[i], ch.anchor, tier)) {
              foundAt = i;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) return { fail: 'no-match' };
        cursor = foundAt + 1;
      }
      const { oldBlock, newBlock } = splitBody(ch.body);
      if (oldBlock.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const inserted = newBlock.map((l) => l.text);
        lines.splice(at, 0, ...inserted);
        cursor = at + inserted.length;
        continue;
      }
      const oldTexts = oldBlock.map((l) => l.text);
      let chosen: { pos: number; tier: number } | null = null;
      for (const tier of tiers) {
        const at = occurrences(lines, oldTexts, tier).filter((p) => p >= cursor);
        if (ch.eof) {
          const eofAt = at.filter((p) => p + oldBlock.length === lines.length);
          if (eofAt.length > 0) {
            chosen = { pos: eofAt[0], tier };
            break;
          }
        } else if (at.length > 0) {
          chosen = { pos: at[0], tier };
          break;
        }
      }
      if (chosen === null) return { fail: 'no-match' };
      const replacement = buildNewLines(oldBlock, newBlock, lines, chosen.pos, chosen.tier);
      lines.splice(chosen.pos, oldBlock.length, ...replacement);
      cursor = chosen.pos + replacement.length;
    }
    return { text: renderFile({ lines, eol: state.eol, ends: state.ends }) };
  };
}

// ---------------------------------------------------------------------------
// Parsing: JSON edits
// ---------------------------------------------------------------------------

interface JsonEdit {
  command: string;
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

/** Validate one edit object, or null when it is not a usable edit. */
function validJsonEdit(v: unknown): JsonEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: o.new_str ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const rawEdits: JsonEdit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFault(first + 1);
    for (const el of arr) {
      const e = validJsonEdit(el);
      if (e === null) throw new ParseFault(first + 1);
      rawEdits.push(e);
    }
    if (rawEdits.length === 0) throw new ParseFault(1);
  } else {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (isBlank(l)) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(l);
      } catch {
        throw new ParseFault(i + 1);
      }
      const e = validJsonEdit(obj);
      if (e === null) throw new ParseFault(i + 1);
      rawEdits.push(e);
    }
    if (rawEdits.length === 0) throw new ParseFault(1);
  }

  return rawEdits.map((e): Edit => {
    if (e.command === 'create') {
      return { kind: 'create', path: e.path, text: e.file_text ?? '' };
    }
    if (e.command === 'str_replace') {
      const transform: Transform = (text: string) => {
        const firstLf = text.indexOf('\n');
        const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
        const hay = crlf ? text.replace(/\r\n/g, '\n') : text;
        const old = crlf ? (e.old_str ?? '').replace(/\r\n/g, '\n') : (e.old_str ?? '');
        const nw = crlf ? (e.new_str ?? '').replace(/\r\n/g, '\n') : (e.new_str ?? '');
        let count = 0;
        let at = hay.indexOf(old);
        while (at >= 0) {
          count += 1;
          at = hay.indexOf(old, at + 1);
        }
        if (count === 0) return { fail: 'no-match' };
        if (count > 1) return { fail: 'ambiguous' };
        const replaced = hay.replace(old, nw);
        return { text: crlf ? replaced.replace(/\n/g, '\r\n') : replaced };
      };
      return { kind: 'change', path: e.path, transform };
    }
    const transform: Transform = (text: string) => {
      const state = parseFile(text);
      const at = e.insert_line ?? 0;
      if (at < 0 || at > state.lines.length) return { fail: 'no-match' };
      const parts = (e.new_str ?? '').split('\n');
      if ((e.new_str ?? '').endsWith('\n')) parts.pop();
      const inserted = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
      const lines = [...state.lines];
      lines.splice(at, 0, ...inserted);
      return { text: renderFile({ lines, eol: state.eol, ends: state.ends }) };
    };
    return { kind: 'change', path: e.path, transform };
  });
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): 'unified' | 'search-replace' | 'v4a' | 'json' | null {
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined && first.trim() === '*** Begin Patch') return 'v4a';
  if (first !== undefined) {
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => stripTrailingWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running the tool
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  out: string[];
}

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function run(argv: string[]): RunResult {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positionals: string[] = [];
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOfOpts = false;
  for (const a of argv) {
    if (!endOfOpts && a === '--') {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return { code: 2, out: ['error: usage'] };
        seenCheck = true;
        checkOnly = true;
      } else if (a === '--strict') {
        if (seenStrict) return { code: 2, out: ['error: usage'] };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { code: 2, out: ['error: usage'] };
        seenFormat = true;
        format = a.slice('--format='.length);
        if (!FORMATS.includes(format)) return { code: 2, out: ['error: usage'] };
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return { code: 2, out: ['error: usage'] };

  let patchText: string;
  const patchArg = positionals[0] ?? null;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = splitPatchLines(patchText);
  let picked: 'unified' | 'search-replace' | 'v4a' | 'json';
  if (format === null || format === 'auto') {
    const found = detectFormat(lines);
    if (found === null) return { code: 2, out: ['error: format'] };
    picked = found;
  } else {
    picked = format as 'unified' | 'search-replace' | 'v4a' | 'json';
  }

  let edits: Edit[];
  try {
    if (picked === 'unified') edits = parseUnified(lines, strict);
    else if (picked === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (picked === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(lines, patchText);
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: [`error: parse ${err.line}`] };
    throw err;
  }

  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; next: string }[] = [];
  for (const e of edits) {
    const r = applyEdit(tree, e);
    if (r.fail !== undefined) failures.push(r.fail);
    else if (r.move !== undefined) moves.push(r.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  const rows = reportRows(tree, moves);
  if (!checkOnly) writeTree(tree);
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}

/** The report lines for what changed: `A`, `D`, `M`, and `R` for a move
 *  whose old path is gone and whose new path is new, in byte order. */
function reportRows(tree: Tree, moves: { old: string; next: string }[]): string[] {
  const kinds = new Map<string, 'A' | 'D' | 'M'>();
  for (const [p, before, after] of tree.touched()) {
    if (before === after) continue;
    if (before === null) kinds.set(p, 'A');
    else if (after === null) kinds.set(p, 'D');
    else kinds.set(p, 'M');
  }
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    if (kinds.get(m.old) === 'D' && kinds.get(m.next) === 'A') {
      kinds.delete(m.old);
      kinds.delete(m.next);
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
    }
  }
  for (const [p, k] of kinds) rows.push({ key: p, text: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.text);
}

/** Write every change to disk: create the directories files need. */
function writeTree(tree: Tree): void {
  for (const [p, before, after] of tree.touched()) {
    if (before === after) continue;
    if (after === null) {
      try {
        rmSync(p);
      } catch {
        // already gone
      }
    } else {
      const dir = dirname(p);
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(p, after, 'utf8');
    }
  }
}

// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts, which reads the checks from the
// env and runs this file on each one without that variable.
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
