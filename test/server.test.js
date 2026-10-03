import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { cleanName, createServer } from '../server.js';

const TAB = 'e|--0--|\nB|--1--|\nG|--0--|\n';

let server;
let origin;
let tabsDir;
let outsideFile;

before(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guitar-tabs-'));
  tabsDir = path.join(root, 'tabs');
  outsideFile = path.join(root, 'secret.txt');
  await fs.writeFile(outsideFile, 'not a tab');
  server = createServer({ tabsDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

// Every test starts without a tabs folder, as a fresh installation does.
beforeEach(() => fs.rm(tabsDir, { recursive: true, force: true }));

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(path.dirname(tabsDir), { recursive: true, force: true });
});

const upload = (name, body, type = 'application/octet-stream') =>
  fetch(`${origin}/api/tabs?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
const list = async () => (await (await fetch(`${origin}/api/tabs`)).json()).map((tab) => tab.name);

// fetch() tidies "/../" out of a URL before sending it; this sends the path as written.
const rawGet = (requestPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: requestPath }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('serves the app', async () => {
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.match(html, /<title>Guitar Tabs<\/title>/);

  const script = await fetch(`${origin}/tab-parser.js`);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  // the icons the page links to
  for (const [, icon] of html.matchAll(/href="(icon-[^"]+)"/g)) {
    const image = await fetch(`${origin}/${icon}`);
    assert.equal(image.status, 200, icon);
    assert.equal(image.headers.get('content-type'), 'image/png');
  }
  assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
  assert.equal((await fetch(`${origin}/`, { method: 'POST' })).status, 405);
});

test('serves nothing from outside the public folder', async () => {
  for (const requestPath of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/a/../../server.js', '/%00.js']) {
    assert.equal(await rawGet(requestPath), 404, requestPath);
  }
});

test('starts with an empty list, also when the tabs folder does not exist yet', async () => {
  assert.deepEqual(await list(), []);
});

test('stores an uploaded tab, lists it, returns it and deletes it', async () => {
  const response = await upload('Scale.tab', TAB);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: 'Scale.tab', created: true });
  assert.equal(await fs.readFile(path.join(tabsDir, 'Scale.tab'), 'utf8'), TAB);
  assert.deepEqual(await list(), ['Scale.tab']);

  const file = await fetch(`${origin}/api/tabs/Scale.tab`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'text/plain');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await file.text(), TAB);

  assert.equal((await fetch(`${origin}/api/tabs/Scale.tab`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await list(), []);
  assert.equal((await fetch(`${origin}/api/tabs/Scale.tab`)).status, 404);
  assert.equal((await fetch(`${origin}/api/tabs/Scale.tab`, { method: 'DELETE' })).status, 404);
});

test('stores the bytes of a file untouched', async () => {
  const latin1 = Buffer.from('F\xfcr Elise\r\ne|--0--|\r\n', 'latin1');
  await upload('elise.tab', latin1);
  assert.deepEqual(await fs.readFile(path.join(tabsDir, 'elise.tab')), latin1);
  const body = Buffer.from(await (await fetch(`${origin}/api/tabs/elise.tab`)).arrayBuffer());
  assert.deepEqual(body, latin1);
});

test('never overwrites a tab', async () => {
  assert.deepEqual(await (await upload('riff.tab', TAB)).json(), { name: 'riff.tab', created: true });
  // the same file again changes nothing
  assert.deepEqual(await (await upload('riff.tab', TAB)).json(), { name: 'riff.tab', created: false });
  // another file under the same name is kept beside the first
  assert.deepEqual(await (await upload('riff.tab', `${TAB}D|--2--|\n`)).json(), { name: 'riff-2.tab', created: true });
  assert.deepEqual(await (await upload('riff.tab', `${TAB}D|--2--|\n`)).json(), { name: 'riff-2.tab', created: false });
  assert.deepEqual(await list(), ['riff.tab', 'riff-2.tab']);
  assert.equal(await fs.readFile(path.join(tabsDir, 'riff.tab'), 'utf8'), TAB);
});

test('keeps uploads inside the tabs folder whatever they are called', async () => {
  for (const [sent, stored] of [
    ['../../escape.tab', 'escape.tab'],
    ['/etc/cron.d/job', 'job'],
    ['..\\..\\windows.tab', 'windows.tab'],
    ['.hidden', 'hidden'],
    ['', 'untitled.tab'],
  ]) {
    assert.equal((await (await upload(sent, `${TAB}${stored}`)).json()).name, stored);
  }
  assert.deepEqual(await fs.readdir(path.dirname(tabsDir)), ['secret.txt', 'tabs']);
  assert.deepEqual((await fs.readdir(tabsDir)).sort(), ['escape.tab', 'hidden', 'job', 'untitled.tab', 'windows.tab']);
});

test('refuses what is not a tab file', async () => {
  assert.equal((await upload('a.tab', TAB, 'text/plain')).status, 415);
  assert.equal((await upload('a.tab', '')).status, 400);
  assert.equal((await upload('a.tab', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))).status, 415);
  const tooLarge = await upload('a.tab', Buffer.alloc(1024 * 1024 + 1, 'x'));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: 'The file is too large.' });
  assert.deepEqual(await list(), []);
});

test('reads and deletes nothing outside the tabs folder', async () => {
  await fs.mkdir(tabsDir);
  await fs.symlink(outsideFile, path.join(tabsDir, 'link.tab'));
  await fs.mkdir(path.join(tabsDir, 'folder.tab'));
  // neither shows up in the list
  assert.deepEqual(await list(), []);
  for (const name of ['..%2Fsecret.txt', '%2E%2E%2Fsecret.txt', '..', '.', '.hidden', 'link.tab', 'folder.tab', '%00', '%E0%A4%A']) {
    const read = await fetch(`${origin}/api/tabs/${name}`);
    assert.ok([400, 404].includes(read.status), `GET ${name} gave ${read.status}`);
    const removed = await fetch(`${origin}/api/tabs/${name}`, { method: 'DELETE' });
    assert.ok([400, 404, 405].includes(removed.status), `DELETE ${name} gave ${removed.status}`);
  }
  assert.equal(await rawGet('/api/tabs/../secret.txt'), 404);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'not a tab');
});

test('opens a file that was copied into the tabs folder by hand', async () => {
  await fs.mkdir(tabsDir);
  await fs.writeFile(path.join(tabsDir, 'Odd [name] #1.tab'), TAB);
  assert.deepEqual(await list(), ['Odd [name] #1.tab']);
  const file = await fetch(`${origin}/api/tabs/${encodeURIComponent('Odd [name] #1.tab')}`);
  assert.equal(await file.text(), TAB);
});

test('cleanName gives tidy, safe names', () => {
  assert.equal(cleanName('blues_licks1.tab'), 'blues_licks1.tab');
  assert.equal(cleanName('Für Elise (easy).tab'), 'Für Elise (easy).tab');
  assert.equal(cleanName('a/b\\c.tab'), 'c.tab');
  assert.equal(cleanName('  spaced\t\tout  .tab'), 'spaced__out .tab');
  assert.equal(cleanName('what?*<>|:".tab'), 'what_______.tab');
  assert.equal(cleanName('...'), 'untitled.tab');
  assert.equal(cleanName(null), 'untitled.tab');
  const long = cleanName(`${'x'.repeat(300)}.tab`);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith('.tab'));
  // cleaning twice changes nothing
  for (const name of ['../x.tab', ' .a b.tab', 'a\nb.tab', `${'y'.repeat(200)}.tab`]) {
    assert.equal(cleanName(cleanName(name)), cleanName(name));
  }
});
