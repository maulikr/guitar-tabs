// Reads the text of an ASCII guitar tab file and finds the staves in it
// (the blocks of "|--3--5--|" lines), keeping the text around them.
//
// Tab files are hand-typed and follow no fixed format, so everything here
// is a heuristic: a line counts as a string line when it is mostly dashes
// (or "=", which some files use for a held note), and neighbouring string
// lines that look alike form one staff.

const TAB_STOP = 8;
// Old tab files stay within 80 columns. A line that grows past that when
// its tab characters are expanded was written with other tab stops.
const MAX_LINE_COLS = 80;
const MIN_STRINGS = 3;
const MAX_NOTES_ABOVE = 4;
const MAX_NOTES_BELOW = 3;
// How far a note line may stick out past the right end of its staff.
const NOTE_OVERHANG = 8;

const MAIL_HEADER =
  /^(date|from|subject|to|cc|newsgroups|message-id|organization|reply-to|sender|received|return-path|references|lines|path|xref|status|in-reply-to|followup-to|distribution|nntp-posting-host|mime-version|content-[\w-]+|x-[\w-]+)\s*:/i;

/**
 * @typedef {Object} Token
 * @property {number} col   column of the first character
 * @property {string} text
 * @property {'fret'|'mark'|'dot'} kind  a fret number, anything else
 *                                      (h, p, /, ~ ...), or a repeat dot
 *
 * @typedef {Object} StaffString
 * @property {string} label     string name as written in the file, '' if none
 * @property {string} cells     the string line, one character per column
 * @property {Token[]} tokens
 * @property {string} trailing  comment written after the line, such as "x2"
 *
 * @typedef {Object} Word
 * @property {number} col   may be negative: left of where the staff starts
 * @property {string} text
 *
 * @typedef {Object} Staff
 * @property {'staff'} type
 * @property {number} width          number of columns
 * @property {StaffString[]} strings top string first
 * @property {number[]} barlines     columns of the bar lines
 * @property {number[]} repeats      columns holding the dots of a repeat sign
 * @property {Word[][]} above        note lines attached above, top first
 * @property {Word[][]} below
 *
 * @typedef {Object} TextSection
 * @property {'text'|'header'} type  'header' is the mail/notice block that
 *                                   archives put at the top of a file
 * @property {string[]} lines
 *
 * @typedef {Object} TabDocument
 * @property {(Staff|TextSection)[]} sections
 */

/**
 * @param {string} text
 * @returns {TabDocument}
 */
export function parseTab(text) {
  const lines = normalizeLines(text);
  const infos = lines.map((line) => analyzeLine(line));
  const blocks = findBlocks(lines, infos);

  /** @type {('header'|'staff'|'note'|undefined)[]} */
  const used = new Array(lines.length);
  const headerEnd = findHeaderEnd(lines);
  for (let i = 0; i < headerEnd; i++) used[i] = 'header';
  for (const block of blocks) {
    for (let i = block.start; i < block.end; i++) used[i] = 'staff';
  }

  const staffAt = new Map();
  for (const block of blocks) {
    const { staff, origin } = buildStaff(block.infos);
    const rightEdge = origin + staff.width + NOTE_OVERHANG;
    const fits = (i) => lines[i].length <= rightEdge;

    const above = [];
    for (let i = block.start - 1; i >= 0 && !used[i] && lines[i] !== ''; i--) above.unshift(i);
    if (above.length <= MAX_NOTES_ABOVE && above.every(fits)) {
      for (const i of above) used[i] = 'note';
      staff.above = above.map((i) => toWords(lines[i], origin));
    }

    const below = [];
    let i = block.end;
    for (; i < lines.length && !used[i] && lines[i] !== ''; i++) below.push(i);
    // Lines squeezed between two staves are left for the staff that follows.
    const endsFree = i >= lines.length || lines[i] === '';
    if (endsFree && below.length <= MAX_NOTES_BELOW && below.every(fits)) {
      for (const j of below) used[j] = 'note';
      staff.below = below.map((j) => toWords(lines[j], origin));
    }
    staffAt.set(block.start, staff);
  }

  /** @type {(Staff|TextSection)[]} */
  const sections = [];
  if (headerEnd > 0) sections.push({ type: 'header', lines: trimBlankLines(lines.slice(0, headerEnd)) });
  let pending = [];
  const flushText = () => {
    const text = trimBlankLines(pending);
    if (text.length) sections.push({ type: 'text', lines: text });
    pending = [];
  };
  for (let i = headerEnd; i < lines.length; i++) {
    if (staffAt.has(i)) {
      flushText();
      sections.push(staffAt.get(i));
    } else if (!used[i]) {
      pending.push(lines[i]);
    }
  }
  flushText();
  return { sections };
}

/**
 * Splits the text into lines with tab characters expanded and line ends
 * cleaned up.
 * @param {string} text
 * @returns {string[]}
 */
export function normalizeLines(text) {
  let lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\r\n|\r\n|\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => expandTabs(line).trimEnd());
  // Some archives doubled every line break; undo that or no two string
  // lines would ever be neighbours.
  const everyOtherBlank = lines.every((line, i) => i % 2 === 0 || line === '');
  if (everyOtherBlank && lines.filter((line) => line !== '').length >= 6) {
    lines = lines.filter((_, i) => i % 2 === 0);
  }
  return lines;
}

function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    out += ch === '\t' ? ' '.repeat(TAB_STOP - (out.length % TAB_STOP)) : ch;
  }
  if (out.trimEnd().length <= MAX_LINE_COLS) return out;
  return line.replace(/ *\t[ \t]*/g, '   ');
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

function findHeaderEnd(lines) {
  let end = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    if (!lines[i].startsWith('#') && !MAIL_HEADER.test(lines[i])) break;
    end = i + 1;
  }
  return end;
}

/**
 * What a single line looks like when read as a string line of a staff.
 * @typedef {Object} LineInfo
 * @property {string} label
 * @property {boolean} dashLabel  the label ran straight into dashes: "E---"
 * @property {number} start       column of the file where `core` begins
 * @property {string} core        the staff part of the line
 * @property {string} trailing
 * @property {boolean} strong     clearly a string line, not just possibly one
 * @property {number[]} pipes     columns of '|' within `core`
 * @property {boolean} wordy      contains a real word, as a heading would
 */

/**
 * @param {string} line
 * @param {boolean} [allowDashLabel]
 * @returns {LineInfo|null} null when the line cannot be a string line
 */
function analyzeLine(line, allowDashLabel = true) {
  if (!line.trim()) return null;
  const { label, start, dashLabel } = splitLabel(line, allowDashLabel);
  const { core, trailing } = splitTrailing(line.slice(start));
  const n = core.length;
  if (n < 3) return null;
  // "PM------|" and "let ring----|" are playing notes, not strings.
  if (/^[^\p{L}\d|-]*(?![xX])\p{L}(?![xX])\p{L}/u.test(core)) return null;

  let dashes = 0;
  let letters = 0;
  let spaces = 0;
  const pipes = [];
  for (let i = 0; i < n; i++) {
    const ch = core[i];
    if (ch === '-' || ch === '=') dashes++;
    else if (ch === '|') pipes.push(i);
    else if (ch === ' ') spaces++;
    else if (/\p{L}/u.test(ch)) letters++;
  }
  if (dashes < 1 || letters > n * 0.5 || spaces > n * 0.3) return null;
  const strong = dashes >= 3 && dashes + pipes.length >= n * 0.4 && letters <= n * 0.3;
  const wordy = /\p{L}{4}/u.test(core.replace(/\([^)]*\)/g, ''));
  return { label, dashLabel, start, core, trailing, strong, pipes, wordy };
}

function splitLabel(line, allowDashLabel) {
  // "e|--", "Eb |--", "E-|--", "1|--", or no label at all: "|--"
  let m = /^\s*(?:([^\s|-]{1,4})\s*-?\s*)?(?=\|)/.exec(line);
  if (m) return { label: (m[1] ?? '').replace(/[:.]+$/, ''), start: m[0].length, dashLabel: false };
  // "e---", "E ---", "E:---", also with a sharp or flat sign after the letter
  m = allowDashLabel ? /^\s*([A-Ha-h][#b\u266F\u266D]?)[:.)]?\s?(?=-)/.exec(line) : null;
  if (m) return { label: m[1], start: m[0].length, dashLabel: true };
  return { label: '', start: line.length - line.trimStart().length, dashLabel: false };
}

// Separates the staff part of a line from a comment written after it:
// "|--0--|  x2", "|--0--| <- let ring", "|--0--|x2".
function splitTrailing(rest) {
  let end = 0;
  for (const m of rest.matchAll(/\S+/g)) {
    if (end > 0 && !isStaffRun(m[0])) break;
    end = m.index + m[0].length;
  }
  let core = rest.slice(0, end);
  let trailing = rest.slice(end).trim();
  const lastPipe = core.lastIndexOf('|');
  if (lastPipe > 0 && lastPipe < core.length - 1 && !/[-=]/.test(core.slice(lastPipe + 1))) {
    trailing = `${core.slice(lastPipe + 1)} ${trailing}`.trim();
    core = core.slice(0, lastPipe + 1);
  }
  return { core, trailing };
}

function isStaffRun(run) {
  if (run.length < 3 || !/^[|=-]/.test(run)) return false;
  const lineChars = run.length - run.replace(/[|=-]/g, '').length;
  return lineChars * 2 >= run.length;
}

/**
 * Groups neighbouring string lines into staves.
 * @param {string[]} lines
 * @param {(LineInfo|null)[]} infos
 * @returns {{ start: number, end: number, infos: LineInfo[] }[]}
 */
function findBlocks(lines, infos) {
  const blocks = [];
  let runStart = 0;
  while (runStart < lines.length) {
    if (!infos[runStart]) {
      runStart++;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < lines.length && infos[runEnd]) runEnd++;
    // Within a run, a line that does not look like its neighbour (a dashed
    // heading, a "|--3--|" triplet bracket) ends the staff.
    let start = runStart;
    for (let i = runStart + 1; i <= runEnd; i++) {
      if (i === runEnd || !alike(infos[i - 1], infos[i])) {
        addBlocks(blocks, lines, infos, start, i);
        start = i;
      }
    }
    runStart = runEnd;
  }
  return blocks;
}

function alike(a, b) {
  let score = 0;
  score += (a.core[0] === '|') === (b.core[0] === '|') ? 1 : -1;
  score += (a.label !== '') === (b.label !== '') ? 1 : -1;
  score += Math.abs(a.start - b.start) <= 1 ? 1 : -1;
  const barsA = barColumns(a);
  const barsB = barColumns(b);
  if (barsA.length && barsB.length) {
    const shared = barsA.filter((col) => barsB.some((other) => Math.abs(col - other) <= 1)).length;
    score += shared * 2 >= Math.max(barsA.length, barsB.length) ? 2 : -2;
  } else if (barsA.length || barsB.length) {
    score -= 1;
  }
  const longer = Math.max(a.core.length, b.core.length);
  score += Math.abs(a.core.length - b.core.length) <= Math.max(3, longer * 0.15) ? 1 : -1;
  if (a.wordy !== b.wordy) score -= 2;
  return score >= 1;
}

// Bar line columns counted from the opening bar line, which is left out.
function barColumns(info) {
  const first = leadingPipe(info);
  const base = first ?? 0;
  return info.pipes.filter((col) => col !== first).map((col) => col - base);
}

// Column of the bar line that opens the line, if it has one.
function leadingPipe(info) {
  return info.pipes.length && info.pipes[0] <= 3 ? info.pipes[0] : null;
}

function addBlocks(blocks, lines, infos, start, end) {
  const count = end - start;
  if (count < MIN_STRINGS) return;
  let group = infos.slice(start, end);
  if (group.filter((info) => info.strong).length < 2) return;

  // A lone "b---" among unlabelled lines is a bend, not the B string.
  const dashLabels = group.filter((info) => info.dashLabel).length;
  if (dashLabels > 0 && dashLabels * 2 < count) {
    group = group.map((info, i) => (info.dashLabel ? analyzeLine(lines[start + i], false) ?? info : info));
  }

  const size = stringsPerStaff(group);
  for (let offset = 0; offset < count; offset += size) {
    blocks.push({ start: start + offset, end: start + offset + size, infos: group.slice(offset, offset + size) });
  }
}

// Staves typed without a blank line between them come out as one long
// group; find how many strings each of them has.
function stringsPerStaff(group) {
  const count = group.length;
  if (count < 8) return count;
  const labels = group.map((info) => info.label.toUpperCase());
  if (labels.every((label) => label !== '')) {
    for (let size = MIN_STRINGS; size <= count / 2; size++) {
      if (count % size === 0 && labels.every((label, i) => label === labels[i % size])) return size;
    }
  }
  for (const size of [6, 7, 4, 5]) {
    if (count % size === 0) return size;
  }
  return count;
}

function mostCommon(values) {
  const counts = new Map();
  let best = values[0];
  for (const value of values) {
    const n = (counts.get(value) ?? 0) + 1;
    counts.set(value, n);
    if (n > counts.get(best)) best = value;
  }
  return best;
}

/**
 * @param {LineInfo[]} infos
 * @returns {{ staff: Staff, origin: number }} origin is the column of the
 *   file that became column 0 of the staff
 */
function buildStaff(infos) {
  // Line the strings up on their opening bar line, so a missing or longer
  // string name does not push one string out of step with the others.
  const leading = infos.map(leadingPipe);
  const withPipe = leading.filter((col) => col !== null);
  const common = withPipe.length ? mostCommon(withPipe) : 0;
  const shifts = leading.map((col) => (col === null ? 0 : common - col));
  const base = Math.min(...shifts);
  const rows = infos.map((info, i) => ' '.repeat(shifts[i] - base) + info.core);
  const origin = mostCommon(infos.map((info, i) => info.start - (shifts[i] - base)));
  const width = Math.max(...rows.map((cells) => cells.length));

  const pipeCounts = new Map();
  for (const cells of rows) {
    for (let col = 0; col < cells.length; col++) {
      if (cells[col] === '|') pipeCounts.set(col, (pipeCounts.get(col) ?? 0) + 1);
    }
  }
  const needed = Math.max(2, Math.ceil(rows.length * 0.6));
  const barlines = [...pipeCounts]
    .filter(([, n]) => n >= needed)
    .map(([col]) => col)
    .sort((a, b) => a - b);

  // "|:" and ":|" down most strings is a repeat sign.
  const nextToBar = (col) => barlines.includes(col - 1) || barlines.includes(col + 1);
  const repeats = [];
  for (let col = 0; col < width; col++) {
    if (nextToBar(col) && rows.filter((cells) => cells[col] === ':').length >= needed) repeats.push(col);
  }

  const strings = infos.map((info, i) => ({
    label: info.label,
    cells: rows[i],
    tokens: tokenize(rows[i], barlines, repeats),
    trailing: info.trailing,
  }));
  return { staff: { type: 'staff', width, strings, barlines, repeats, above: [], below: [] }, origin };
}

function tokenize(cells, barlines, repeats) {
  /** @type {Token[]} */
  const tokens = [];
  for (const run of cells.matchAll(/[^\s|-]+/g)) {
    for (const part of run[0].matchAll(/\d+|[:*]|[^\d:*]+/g)) {
      const text = part[0];
      const col = run.index + part.index;
      if (text === ':' && repeats.includes(col)) continue;
      // "||*" on the middle strings is the other way to type a repeat sign.
      const dot = text === '*' && (barlines.includes(col - 1) || barlines.includes(col + 1));
      const kind = dot ? 'dot' : /^(\d+|[xX]+)$/.test(text) ? 'fret' : 'mark';
      tokens.push({ col, text, kind });
    }
  }
  // A '|' that the other strings do not share is not a bar line; keep it
  // as a mark on its own string.
  for (let col = 0; col < cells.length; col++) {
    if (cells[col] === '|' && !barlines.includes(col)) tokens.push({ col, text: '|', kind: 'mark' });
  }
  return tokens.sort((a, b) => a.col - b.col);
}

/**
 * @param {string} line
 * @param {number} origin  column of the file where the staff starts
 * @returns {Word[]}
 */
function toWords(line, origin) {
  return [...line.matchAll(/\S+/g)].map((m) => ({ col: m.index - origin, text: m[0] }));
}
