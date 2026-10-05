// Draws a parsed tab document as HTML: the text as it is, each staff as SVG.
//
// A staff keeps the columns of the file: a character in column 12 of the
// file is drawn 12 column widths from the start of the staff. That keeps
// the spacing the author typed, whatever symbols they used.

/** @import { TabDocument, Word } from './tab-parser.js' */

// Sizes in CSS pixels.
const COL_WIDTH = 10; // one column, when there is room
const MIN_COL_WIDTH = 7.2; // tightest spacing before staves are wrapped
const WRAP_COL_WIDTH = 8.4; // spacing once staves have to wrap anyway
const LINE_GAP = 14; // distance between two strings
const FRET_SIZE = 12.5;
const MARK_SIZE = 11;
const LABEL_SIZE = 11.5;
const NOTE_SIZE = 11.5; // text above, below and after a staff
const NOTE_CHAR_WIDTH = 7; // a monospace character at NOTE_SIZE
const NOTE_LINE = 15;
const DOUBLE_BAR_GAP = 3.5;
const DOT_RADIUS = 2.2;
const MIN_WIDTH = 200;
const MIN_ROW_COLS = 12;
// Longer comments after a string go below the staff instead of beside it.
const MAX_TRAILING_CHARS = 24;
// A paragraph of text up to this long stays on one page when printed. A
// longer one would leave too much of a page empty.
const MAX_KEPT_LINES = 25;
const STANDARD_TUNING = ['E', 'B', 'G', 'D', 'A', 'E'];
// Marks that draw a line along the string rather than spell something.
const DRAWN_LINE = /^[~=._^*]{2,}$/;

/**
 * @param {TabDocument} doc
 * @param {{ width?: number }} [options]  width available to a staff
 * @returns {string} HTML
 */
export function renderDocument(doc, options = {}) {
  const width = Math.max(MIN_WIDTH, Math.floor(options.width ?? 720));
  const layouts = new Map();
  for (const section of doc.sections) {
    if (section.type === 'staff') layouts.set(section, { frame: frameOf(section), rows: [] });
  }
  const colWidth = layOut(layouts, width);
  return doc.sections
    .map((section) => {
      if (section.type === 'staff') return renderStaff(section, layouts.get(section), colWidth);
      if (section.type === 'header') {
        const text = esc(section.lines.join('\n'));
        return `<details class="file-header"><summary>File header</summary><pre>${text}</pre></details>`;
      }
      return renderText(section.lines);
    })
    .join('\n');
}

/**
 * Text as it was typed, with every paragraph in a block of its own: a page
 * break may fall between paragraphs, but not inside a short one, which is
 * often a diagram drawn with characters.
 * @param {string[]} lines
 */
function renderText(lines) {
  // A paragraph takes the blank lines after it along.
  const paragraphs = [];
  lines.forEach((line, i) => {
    if (i === 0 || (line !== '' && lines[i - 1] === '')) paragraphs.push([]);
    paragraphs[paragraphs.length - 1].push(line);
  });
  const html = paragraphs
    .map((paragraph) => {
      const kept = paragraph.filter((line) => line !== '').length <= MAX_KEPT_LINES;
      // Every line ends with a line break, also the last: as a block, the
      // paragraph is then exactly as tall as its lines.
      const text = esc(paragraph.map((line) => `${line}\n`).join(''));
      return `<span class="${kept ? 'para keep' : 'para'}">${text}</span>`;
    })
    .join('');
  return `<pre class="tab-text">${html}</pre>`;
}

// The room a staff needs around its columns.
function frameOf(staff) {
  const written = staff.strings.map((string) => string.label);
  const unlabelled = written.every((label) => label === '');
  const labels = unlabelled && written.length === STANDARD_TUNING.length ? STANDARD_TUNING : written;
  const labelChars = Math.max(...labels.map((label) => label.length));
  const words = [...staff.above, ...staff.below].flat();
  const firstCol = Math.min(0, ...words.map((word) => word.col));
  const trailingChars = Math.max(...staff.strings.map((string) => string.trailing.length));
  const trailingBeside = trailingChars > 0 && trailingChars <= MAX_TRAILING_CHARS;
  return {
    labels,
    trailingBeside,
    left: Math.max(labelChars ? 12 + labelChars * 8 : 6, 2 - firstCol * COL_WIDTH),
    right: trailingBeside ? 12 + trailingChars * NOTE_CHAR_WIDTH : 6,
    cols: Math.max(staff.width, ...words.map((word) => word.col + word.text.length)),
  };
}

/**
 * Decides the rows of every staff and the width of a column. The whole
 * document gets one column width, so every staff has the same rhythm: the
 * natural one if the widest staff fits, a tighter one if that is enough to
 * make it fit, and otherwise the wide staves are wrapped.
 * @returns {number} the column width
 */
function layOut(layouts, width) {
  const room = ({ frame }) => width - frame.left - frame.right;
  let fit = COL_WIDTH;
  for (const layout of layouts.values()) fit = Math.min(fit, room(layout) / layout.frame.cols);
  const wrapping = fit < MIN_COL_WIDTH;

  let colWidth = COL_WIDTH;
  for (const [staff, layout] of layouts) {
    const { cols } = layout.frame;
    const capacity = Math.max(MIN_ROW_COLS, Math.floor(room(layout) / (wrapping ? WRAP_COL_WIDTH : fit) + 0.001));
    layout.rows = cols <= capacity ? [[0, cols]] : splitRows(staff, cols, capacity);
    const widest = Math.max(...layout.rows.map(([from, to]) => to - from));
    colWidth = Math.min(colWidth, room(layout) / widest);
  }
  return Math.floor(colWidth * 100) / 100;
}

function renderStaff(staff, { frame, rows }, colWidth) {
  let html = rows
    .map(([from, to], i) => renderRow(staff, frame, colWidth, from, to, i === 0, i === rows.length - 1))
    .join('');
  if (!frame.trailingBeside) {
    const comments = staff.strings.map((string) => string.trailing).filter(Boolean);
    if (comments.length) html += renderText(comments);
  }
  return `<div class="staff-block">${html}</div>`;
}

/**
 * Cuts a staff that is too wide into rows, at bar lines where it can.
 * @returns {[number, number][]} column ranges, end not included
 */
function splitRows(staff, cols, capacity) {
  const bars = new Set(staff.barlines);
  const barEnds = staff.barlines
    .filter((col) => !bars.has(col + 1)) // keep a double bar line together
    .map((col) => col + 1)
    .filter((end) => end > 2 && end < staff.width - 1);
  // The columns where a row may end.
  const points = [0];
  const addPoint = (col) => {
    // No way to end a row in reach: cut straight through.
    while (col - points[points.length - 1] > capacity) points.push(points[points.length - 1] + capacity);
    points.push(col);
  };
  const quiet = (col) => staff.strings.every(({ cells }) => col >= cells.length || '-= '.includes(cells[col]));
  for (const end of [...barEnds, cols]) {
    const from = points[points.length - 1];
    if (end - from > capacity) {
      // A bar longer than a row may be cut wherever no string has a note.
      for (let col = from + 2; col < end - 1; col++) {
        if (quiet(col - 1) && quiet(col)) addPoint(col);
      }
    }
    addPoint(end);
  }

  // Fewest rows first, then rows of similar length. Later rows weigh a
  // little more, so that a short row ends up last.
  const best = points.map(() => null);
  best[0] = { rows: 0, cost: 0, prev: -1 };
  for (let j = 1; j < points.length; j++) {
    for (let i = j - 1; i >= 0 && points[j] - points[i] <= capacity; i--) {
      const span = points[j] - points[i];
      const rows = best[i].rows + 1;
      const cost = best[i].cost + span * span * (1 + 0.02 * best[i].rows);
      if (!best[j] || rows < best[j].rows || (rows === best[j].rows && cost < best[j].cost)) {
        best[j] = { rows, cost, prev: i };
      }
    }
  }
  const rows = [];
  for (let j = points.length - 1; j > 0; j = best[j].prev) {
    rows.unshift([points[best[j].prev], points[j]]);
  }
  return rows;
}

function renderRow(staff, frame, colWidth, from, to, isFirst, isLast) {
  const count = staff.strings.length;
  const top = staff.above.length ? 16 + staff.above.length * NOTE_LINE : 10;
  const bottom = top + (count - 1) * LINE_GAP;
  const height = staff.below.length ? bottom + 16 + staff.below.length * NOTE_LINE : bottom + 10;
  const staffEnd = Math.min(to, staff.width);
  const left = (col) => frame.left + (col - from) * colWidth;
  const y = (i) => top + i * LINE_GAP + 0.5;
  const width = Math.ceil(left(to) + (isLast ? frame.right : 6));

  // x of every bar line in this row; the two lines of "||" are drawn close together.
  const barX = new Map();
  const bars = staff.barlines.filter((col) => col >= from && col < staffEnd);
  for (let i = 0; i < bars.length; i++) {
    if (bars[i + 1] === bars[i] + 1) {
      barX.set(bars[i], left(bars[i] + 1) - DOUBLE_BAR_GAP / 2);
      barX.set(bars[i + 1], left(bars[i] + 1) + DOUBLE_BAR_GAP / 2);
      i++;
    } else {
      barX.set(bars[i], left(bars[i]) + colWidth / 2);
    }
  }

  let lines = '';
  let gaps = '';
  let frets = '';
  let marks = '';
  let dots = '';
  let trailing = '';
  const dot = (x, cy) => `<circle cx="${num(x + colWidth / 2)}" cy="${num(cy)}" r="${DOT_RADIUS}"/>`;
  // A repeat sign has its two dots in the spaces around the middle.
  const middle = (y(0) + y(count - 1)) / 2;
  const spread = count % 2 === 0 ? LINE_GAP : LINE_GAP / 2;
  for (const col of staff.repeats) {
    if (col >= from && col < staffEnd) dots += dot(left(col), middle - spread) + dot(left(col), middle + spread);
  }
  staff.strings.forEach((string, i) => {
    // The string itself, left out wherever the file has spaces.
    for (const run of string.cells.slice(from, staffEnd).matchAll(/\S+/g)) {
      const first = from + run.index;
      const last = first + run[0].length - 1;
      lines += `M${num(barX.get(first) ?? left(first))} ${y(i)}H${num(barX.get(last) ?? left(last + 1))}`;
    }
    for (const token of string.tokens) {
      // A drawn line such as "~~~~" or "====" keeps one character per
      // column, and may run on into the next row.
      const drawn = token.kind === 'mark' && DRAWN_LINE.test(token.text);
      const start = drawn ? Math.max(token.col, from) : token.col;
      const end = drawn ? Math.min(token.col + token.text.length, staffEnd) : token.col + token.text.length;
      if (start < from || start >= staffEnd || start >= end) continue;
      const span = (end - start) * colWidth;
      const x = left(start);
      if (token.kind === 'dot') {
        dots += dot(x, y(i));
        continue;
      }
      gaps += `<rect x="${num(x)}" y="${num(y(i) - LINE_GAP / 2 + 1)}" width="${num(span)}" height="${LINE_GAP - 2}"/>`;
      const size = token.kind === 'fret' ? FRET_SIZE : MARK_SIZE;
      const baseline = num(y(i) + size * 0.36);
      if (drawn) {
        const xs = Array.from({ length: end - start }, (_, k) => num(left(start + k) + colWidth / 2)).join(' ');
        marks += `<text x="${xs}" y="${baseline}">${esc(token.text.slice(start - token.col, end - token.col))}</text>`;
      } else if (token.kind === 'fret') {
        frets += `<text x="${num(x + span / 2)}" y="${baseline}">${esc(token.text)}</text>`;
      } else {
        marks += `<text x="${num(x + span / 2)}" y="${baseline}">${esc(token.text)}</text>`;
      }
    }
    if (isLast && frame.trailingBeside && string.trailing) {
      trailing += `<text x="${num(left(staffEnd) + 8)}" y="${num(y(i) + NOTE_SIZE * 0.36)}">${esc(string.trailing)}</text>`;
    }
  });

  let barPath = '';
  // A row that does not open with a bar line still gets a left edge.
  if (!barX.has(from)) barPath += `M${num(left(from))} ${y(0)}V${y(count - 1)}`;
  for (const x of barX.values()) barPath += `M${num(x)} ${y(0)}V${y(count - 1)}`;

  const labels = frame.labels
    .map((label, i) =>
      label ? `<text x="${num(frame.left - 7)}" y="${num(y(i) + LABEL_SIZE * 0.36)}">${esc(label)}</text>` : '',
    )
    .join('');

  const inRow = (word) => (isFirst || word.col >= from) && (isLast || word.col < to);
  let notes = '';
  staff.above.forEach((words, k) => {
    const baseline = 4 + k * NOTE_LINE + NOTE_SIZE;
    for (const word of words.filter(inRow)) notes += noteText(word, left, colWidth, baseline);
  });
  staff.below.forEach((words, k) => {
    const baseline = bottom + 12 + k * NOTE_LINE + NOTE_SIZE;
    for (const word of words.filter(inRow)) notes += noteText(word, left, colWidth, baseline);
  });

  return (
    `<svg class="staff" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="Tab staff">` +
    `<path class="strings" d="${lines}"/>` +
    `<g class="gaps">${gaps}</g>` +
    `<path class="bars" d="${barPath}"/>` +
    `<g class="dots">${dots}</g>` +
    `<g class="labels" font-size="${LABEL_SIZE}">${labels}</g>` +
    `<g class="frets" font-size="${FRET_SIZE}">${frets}</g>` +
    `<g class="marks" font-size="${MARK_SIZE}">${marks}</g>` +
    `<g class="notes" font-size="${NOTE_SIZE}">${notes}${trailing}</g>` +
    `</svg>`
  );
}

/**
 * A word of a note line, kept on the columns it was typed in.
 * @param {Word} word
 */
function noteText(word, left, colWidth, baseline) {
  const chars = [...word.text];
  const mid = (col) => num(left(col) + colWidth / 2);
  // Single characters (beat counts) and words with a drawn line in them
  // ("PM-----|", "~~~~") are centred on their columns; other words read
  // better at their own width.
  if (chars.length === 1 || /[-~._=]{2}/.test(word.text)) {
    const xs = chars.map((_, k) => mid(word.col + k)).join(' ');
    return `<text class="spaced" x="${xs}" y="${baseline}">${esc(word.text)}</text>`;
  }
  return `<text x="${num(left(word.col) + 1)}" y="${baseline}">${esc(word.text)}</text>`;
}

function num(value) {
  return Math.round(value * 100) / 100;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
