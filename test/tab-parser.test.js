import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLines, parseTab } from '../public/tab-parser.js';

const staves = (doc) => doc.sections.filter((section) => section.type === 'staff');
const textOf = (doc) =>
  doc.sections
    .filter((section) => section.type === 'text')
    .flatMap((section) => section.lines)
    .join('\n');
const frets = (string) => string.tokens.filter((token) => token.kind === 'fret').map((token) => `${token.col}:${token.text}`);
const words = (line) => line.map((word) => `${word.col}:${word.text}`);

// The layout of the archive files: a notice and mail header on top, text
// typed with tab characters, staves without string names.
const ARCHIVE_FILE = [
  '#-------------------------------PLEASE NOTE-------------------------------#',
  '#This file is the author\'s own work.                                     #',
  '#-------------------------------------------------------------------------#',
  'Date: Fri, 14 Apr 95 00:20:05 -0100',
  'From: Somebody <somebody@example.org>',
  'Subject: INFO: Two licks',
  '',
  'Two Licks',
  '---------',
  '',
  'Lick 1:\t\t\t\t\t\t\t\t\t\t\t\t\t\tLick 2:',
  '',
  '|--------------5--|-----------------|',
  '|-----------------|-----------------|',
  '|-8--7--5--7(BU)--|-------8--7------|',
  '|-----------------|-------7--6------|',
  '|-----------------|-4--5--8--7------|',
  '|-----------------|-----------------|',
  '',
].join('\r\n');

test('reads a file in the archive layout', () => {
  const doc = parseTab(ARCHIVE_FILE);
  assert.deepEqual(
    doc.sections.map((section) => section.type),
    ['header', 'text', 'staff'],
  );
  assert.equal(doc.sections[0].lines.length, 6);
  assert.equal(doc.sections[0].lines[5], 'Subject: INFO: Two licks');
  // the dashed underline is text, and the run of tab characters is not
  // blown up into a hundred spaces
  assert.deepEqual(doc.sections[1].lines, ['Two Licks', '---------', '', 'Lick 1:   Lick 2:']);

  const [staff] = staves(doc);
  assert.equal(staff.strings.length, 6);
  assert.equal(staff.width, 37);
  assert.deepEqual(staff.barlines, [0, 18, 36]);
  assert.ok(staff.strings.every((string) => string.label === ''));
  assert.deepEqual(frets(staff.strings[0]), ['15:5']);
  assert.deepEqual(frets(staff.strings[2]), ['2:8', '5:7', '8:5', '11:7', '26:8', '29:7']);
  assert.deepEqual(
    staff.strings[2].tokens.filter((token) => token.kind === 'mark'),
    [{ col: 12, text: '(BU)', kind: 'mark' }],
  );
});

test('keeps string names, chords above and counts below', () => {
  const doc = parseTab(`Pattern in A minor

     Am              C
e|-----0-----------0-------|
B|---1---1-------1---1-----|
G|-2-------2---0-------0---|
D|-------------------------|
A|-0-----------3-----------|
E|-------------------------|
   1 + 2 + 3 + 4 + 1 + 2 +
   Slow-ly     now

Play it four times.
`);
  const [staff] = staves(doc);
  assert.deepEqual(
    staff.strings.map((string) => string.label),
    ['e', 'B', 'G', 'D', 'A', 'E'],
  );
  assert.deepEqual(staff.barlines, [0, 26]);
  // columns count from the opening bar line, so "Am" sits over the note in column 6
  assert.deepEqual(staff.above.map(words), [['4:Am', '20:C']]);
  assert.equal(staff.below.length, 2);
  assert.deepEqual(words(staff.below[0]).slice(0, 3), ['2:1', '4:+', '6:2']);
  assert.deepEqual(words(staff.below[1]), ['2:Slow-ly', '14:now']);
  assert.equal(textOf(doc), 'Pattern in A minor\nPlay it four times.');
});

test('reads staves typed without bar lines', () => {
  const doc = parseTab(`E-----------------0--1--3--
B-----------0--1-----------
G--------0-----------------
D--0--2--------------------
A--------------------------
E--------------------------

E ---3--1--0---
B -----------3-
G -------------
`);
  const [first, second] = staves(doc);
  assert.deepEqual(
    first.strings.map((string) => string.label),
    ['E', 'B', 'G', 'D', 'A', 'E'],
  );
  assert.deepEqual(first.barlines, []);
  assert.deepEqual(frets(first.strings[0]), ['17:0', '20:1', '23:3']);
  assert.equal(second.strings.length, 3);
  assert.deepEqual(frets(second.strings[0]), ['3:3', '6:1', '9:0']);
});

test('keeps playing techniques as marks between the frets', () => {
  const doc = parseTab(`e|--5h7p5--7b9r7~~--<12>--(5)--x--10h12--|
B|---------------------------------------|
G|--3/5--5\\3-----------------------------|
`);
  const [staff] = staves(doc);
  assert.deepEqual(
    staff.strings[0].tokens.map((token) => `${token.text}:${token.kind}`),
    [
      '5:fret', 'h:mark', '7:fret', 'p:mark', '5:fret',
      '7:fret', 'b:mark', '9:fret', 'r:mark', '7:fret', '~~:mark',
      '<:mark', '12:fret', '>:mark',
      '(:mark', '5:fret', '):mark',
      'x:fret',
      '10:fret', 'h:mark', '12:fret',
    ],
  );
  assert.deepEqual(
    staff.strings[2].tokens.map((token) => token.text),
    ['3', '/', '5', '5', '\\', '3'],
  );
});

test('a palm mute line above a staff is a note, not a seventh string', () => {
  const doc = parseTab(`   PM--------|     let ring
e|-----------|-----------------|
B|-----------|--5--7--5--------|
G|-----------|-----------7-----|
D|--2-2-2-2--|-----------------|
A|--0-0-0-0--|-----------------|
E|-----------|-----------------|
`);
  const [staff] = staves(doc);
  assert.equal(staff.strings.length, 6);
  assert.deepEqual(staff.above.map(words), [['2:PM--------|', '18:let', '22:ring']]);
});

test('dashed headings next to a staff stay out of it', () => {
  const doc = parseTab(`--------- Verse ---------
e|--0-----0-----0--|
B|--1-----1-----1--|
G|--0-----0-----0--|
D|--2-----2-----2--|
A|--3-----3-----3--|
E|-----------------|
-------------------
`);
  const [staff] = staves(doc);
  assert.equal(staves(doc).length, 1);
  assert.equal(staff.strings.length, 6);
  assert.deepEqual(staff.above.map(words), [['-1:---------', '9:Verse', '15:---------']]);
  assert.deepEqual(staff.below.map(words), [['-1:-------------------']]);
});

test('splits staves typed without a blank line between them', () => {
  const block = (fret) =>
    ['D ', 'A ', 'F#', 'D ', 'A ', 'D '].map((name) => `${name}|--${fret}-----${fret}--|`).join('\n');
  const doc = parseTab(`${block(0)}\n${block(5)}\n`);
  assert.equal(staves(doc).length, 2);
  for (const staff of staves(doc)) {
    assert.deepEqual(
      staff.strings.map((string) => string.label),
      ['D', 'A', 'F#', 'D', 'A', 'D'],
    );
  }
  assert.deepEqual(frets(staves(doc)[1].strings[0]), ['3:5', '9:5']);

  const unlabelled = Array.from({ length: 12 }, () => '|--3--3--|').join('\n');
  assert.deepEqual(
    staves(parseTab(unlabelled)).map((staff) => staff.strings.length),
    [6, 6],
  );
});

test('reads a four string bass staff', () => {
  const doc = parseTab(`G|----------------|
D|------2-----2---|
A|--0-3-----3-----|
E|----------------|
`);
  const [staff] = staves(doc);
  assert.deepEqual(
    staff.strings.map((string) => string.label),
    ['G', 'D', 'A', 'E'],
  );
});

test('lines the strings up when their names differ in length', () => {
  const doc = parseTab(`D|--0--2--|
A|--0--2--|
F#|--0--2--|
D|--0--2--|
A|--0--2--|
D|--0--2--|
`);
  const [staff] = staves(doc);
  assert.equal(staff.strings.length, 6);
  assert.deepEqual(staff.barlines, [0, 9]);
  for (const string of staff.strings) assert.deepEqual(frets(string), ['3:0', '6:2']);
});

test('one string with its closing bar line a column off does not break the staff', () => {
  const doc = parseTab(`e|---0---2---3---|
B|---1---3---5----|
G|---0---2---4---|
D|---------------|
A|---------------|
E|---------------|
`);
  const [staff] = staves(doc);
  assert.equal(staves(doc).length, 1);
  assert.equal(staff.strings.length, 6);
  assert.deepEqual(staff.barlines, [0, 16]);
  // the stray bar line is kept as a mark on its own string
  assert.deepEqual(staff.strings[1].tokens.at(-1), { col: 17, text: '|', kind: 'mark' });
});

test('separates comments written after a string', () => {
  const doc = parseTab(`e|--0--|
B|--1--|  x4
G|--0--|x2
D|--2--| <-- let ring
A|--3--|
E|-----|
`);
  const [staff] = staves(doc);
  assert.deepEqual(
    staff.strings.map((string) => string.trailing),
    ['', 'x4', 'x2', '<-- let ring', '', ''],
  );
  assert.ok(staff.strings.every((string) => string.cells === string.cells.slice(0, 7)));
  assert.equal(staff.width, 7);
});

test('recognises repeat signs', () => {
  const colons = parseTab(`e|:-----0-----:|
B|:---1---1---:|
G|:-2-------2-:|
D|:-----------:|
`);
  const [first] = staves(colons);
  assert.deepEqual(first.repeats, [1, 13]);
  assert.ok(first.strings.every((string) => string.tokens.every((token) => token.text !== ':')));

  const stars = parseTab(`e||---------||
B||--3---3--||
G||*-------*||
D||*-0---0-*||
A||---------||
E||---------||
`);
  const [second] = staves(stars);
  assert.deepEqual(second.barlines, [0, 1, 11, 12]);
  assert.deepEqual(
    second.strings[2].tokens,
    [
      { col: 2, text: '*', kind: 'dot' },
      { col: 10, text: '*', kind: 'dot' },
    ],
  );
});

test('a single line starting with "b" among unnamed strings is not the B string', () => {
  const doc = parseTab(`---------7-----
b--------------
---------------
---------------
`);
  const [staff] = staves(doc);
  assert.ok(staff.strings.every((string) => string.label === ''));
  assert.equal(staff.strings[1].cells, 'b--------------');
});

test('does not take dashes in ordinary text for a staff', () => {
  const doc = parseTab(`Song title
----------

Chords used:  C - G - Am - F
C-G-Am-F
C-G-F-C
Am-F-C-G

+--------+--------+
| Am     | x02210 |
| C      | x32010 |
+--------+--------+

Strumming:  D-DU-UDU
            1-2-3-4-

E: 022100
A: x02210
D: xx0232

-------------------------------
no staff anywhere in this file
-------------------------------
`);
  assert.equal(staves(doc).length, 0);
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].lines.length, 23);
});

test('copes with the line endings and control characters of old files', () => {
  assert.deepEqual(normalizeLines('\uFEFFa\r\nb\rc\nd\u001A'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(normalizeLines('a\tb'), ['a       b']);
  assert.deepEqual(normalizeLines('trailing   \t'), ['trailing']);

  // every line break doubled
  const doubled = ['e|--0--|', 'B|--1--|', 'G|--0--|', 'D|--2--|', 'A|--3--|', 'E|-----|'].join('\r\r\n\r\r\n');
  assert.equal(staves(parseTab(doubled)).length, 1);
  const spaced = ['e|--0--|', 'B|--1--|', 'G|--0--|', 'D|--2--|', 'A|--3--|', 'E|-----|'].join('\n\n');
  assert.equal(staves(parseTab(spaced))[0].strings.length, 6);
});

test('an empty file gives an empty document', () => {
  assert.deepEqual(parseTab(''), { sections: [] });
  assert.deepEqual(parseTab('\n\n   \n'), { sections: [] });
});

test('keeps notes typed before the opening bar line, and the chords in step with them', () => {
  const doc = parseTab(`   Am
-|-0---2---|
-|-1---3---|
3|-2---4---|
-|---------|
`);
  const [staff] = staves(doc);
  assert.deepEqual(staff.barlines, [1, 11]);
  assert.deepEqual(frets(staff.strings[0]), ['3:0', '7:2']);
  // "Am" is typed over the column of the first note
  assert.deepEqual(staff.above.map(words), [['3:Am']]);
});

test('reads the "E-|" way of naming strings and "=" for held notes', () => {
  const doc = parseTab(`E-|--3-3-3-|-----8---|
B-|-1------|---8-----|
G-|--------|-9=======|
D-|========|---------|
`);
  const [staff] = staves(doc);
  assert.deepEqual(
    staff.strings.map((string) => string.label),
    ['E', 'B', 'G', 'D'],
  );
  assert.deepEqual(staff.barlines, [0, 9, 19]);
  assert.deepEqual(staff.strings[3].tokens, [{ col: 1, text: '========', kind: 'mark' }]);
});
