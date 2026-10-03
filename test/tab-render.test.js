import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTab } from '../public/tab-parser.js';
import { renderDocument } from '../public/tab-render.js';

const render = (text, width) => renderDocument(parseTab(text), { width });
const svgs = (html) => html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
const group = (svg, name) => new RegExp(`<g class="${name}"[^>]*>(.*?)</g>`).exec(svg)[1];
const texts = (markup) => [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const widthOf = (svg) => Number(/ width="(\d+)"/.exec(svg)[1]);

const SIX_STRINGS = `|--0--2--3--|--------|
|-----------|--1--3--|
|-----------|--------|
|-----------|--------|
|-----------|--------|
|--3--------|--------|
`;

test('draws a staff as one svg with its frets, strings and bar lines', () => {
  const html = render(SIX_STRINGS, 700);
  const [svg] = svgs(html);
  assert.equal(svgs(html).length, 1);
  assert.deepEqual(texts(group(svg, 'frets')), ['0', '2', '3', '1', '3', '3']);
  // one line per string, and the three bar lines
  assert.equal(/<path class="strings" d="([^"]*)"/.exec(svg)[1].split('M').length - 1, 6);
  assert.equal(/<path class="bars" d="([^"]*)"/.exec(svg)[1].split('M').length - 1, 3);
  // every fret number blanks out the string behind it
  assert.equal(group(svg, 'gaps').split('<rect').length - 1, 6);
});

test('names the strings of an unnamed six string staff in standard tuning', () => {
  const [svg] = svgs(render(SIX_STRINGS, 700));
  assert.deepEqual(texts(group(svg, 'labels')), ['E', 'B', 'G', 'D', 'A', 'E']);
});

test('uses the string names of the file when it has them', () => {
  const named = ['D', 'A', 'F#', 'D', 'A', 'D'].map((name) => `${name.padEnd(2)}|--0--2--|`).join('\n');
  assert.deepEqual(texts(group(svgs(render(named, 700))[0], 'labels')), ['D', 'A', 'F#', 'D', 'A', 'D']);

  // no guessing for anything but six strings
  const four = Array.from({ length: 4 }, () => '|--0--2--|').join('\n');
  assert.deepEqual(texts(group(svgs(render(four, 700))[0], 'labels')), []);
});

test('wraps a staff that is too wide at its bar lines', () => {
  const bar = '-0-1-3-5-7-8-10-12-|';
  const wide = Array.from({ length: 6 }, (_, i) => `|${(i === 0 ? bar : `${'-'.repeat(19)}|`).repeat(6)}`).join('\n');
  const one = svgs(render(wide, 1400));
  assert.equal(one.length, 1);

  const rows = svgs(render(wide, 500));
  assert.ok(rows.length > 1);
  for (const row of rows) assert.ok(widthOf(row) <= 500, `row of ${widthOf(row)}px in 500px`);
  // nothing lost, nothing drawn twice
  assert.deepEqual(rows.flatMap((row) => texts(group(row, 'frets'))), texts(group(one[0], 'frets')));
  // every row carries the string names
  for (const row of rows) assert.equal(texts(group(row, 'labels')).length, 6);
});

test('wraps a long staff without bar lines between the notes', () => {
  const notes = Array.from({ length: 40 }, (_, i) => `--${i % 13}`).join('');
  const wide = Array.from({ length: 6 }, (_, i) => `|${i === 0 ? notes : '-'.repeat(notes.length)}`).join('\n');
  const rows = svgs(render(wide, 360));
  assert.ok(rows.length > 2);
  for (const row of rows) assert.ok(widthOf(row) <= 360);
  assert.deepEqual(
    rows.flatMap((row) => texts(group(row, 'frets'))),
    Array.from({ length: 40 }, (_, i) => String(i % 13)),
  );
});

test('tightens the spacing before it wraps', () => {
  const line = `|${'--5'.repeat(26)}--|`; // 81 columns
  const staff = Array.from({ length: 6 }, () => line).join('\n');
  // too narrow for the natural spacing, wide enough for a tighter one
  const html = render(staff, 740);
  assert.equal(svgs(html).length, 1);
  assert.ok(widthOf(svgs(html)[0]) <= 740);
});

test('draws note lines, comments and repeat dots', () => {
  const html = render(
    `     Am      C
e|:-----0-----:|
B|:---1---1---:|  x4
G|:-2-------2-:|
D|:-----------:|
A|:-0---------:|
E|:-----------:|
   1 + 2 + 3 +
`,
    700,
  );
  const [svg] = svgs(html);
  assert.deepEqual(texts(group(svg, 'notes')), ['Am', 'C', '1', '+', '2', '+', '3', '+', 'x4']);
  assert.equal(group(svg, 'dots').split('<circle').length - 1, 4);
});

test('shows the text around the staves, and the file header folded away', () => {
  const html = render(`#---- PLEASE NOTE ----#
Subject: a tab

Intro riff:

${SIX_STRINGS}
Then the chorus.
`);
  assert.match(html, /<details class="file-header"><summary>File header<\/summary><pre>#---- PLEASE NOTE ----#\nSubject: a tab<\/pre><\/details>/);
  assert.match(html, /<pre class="tab-text">Intro riff:<\/pre>/);
  assert.match(html, /<pre class="tab-text">Then the chorus.<\/pre>/);
  assert.ok(html.indexOf('Intro riff') < html.indexOf('<svg') && html.indexOf('<svg') < html.indexOf('Then the chorus'));
});

test('never lets text from a file through as markup', () => {
  const html = render(`<img src=x onerror=alert(1)> & "quotes"

  <b>Am</b>
<i>|--0--<script>alert(1)</script>--|  <u>x2</u>
<i>|--------------------------------|
<i>|--------------------------------|
<i>|--------------------------------|
`);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;'));
  for (const tag of ['<img', '<script', '<b>', '<i>', '<u>']) {
    assert.ok(!html.includes(tag), `${tag} came through`);
  }
});

test('a document without staves is only text', () => {
  const html = render('Just some words.\nAnd more.');
  assert.equal(html, '<pre class="tab-text">Just some words.\nAnd more.</pre>');
});
