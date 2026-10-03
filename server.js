// Serves the app from ./public and keeps the uploaded tab files in ./tabs.
// The files are stored exactly as uploaded; reading them is the browser's job.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 100;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

// Tab files come from anywhere and their text ends up on the page, so the
// browser is told to run nothing but the app's own files.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ publicDir?: string, tabsDir?: string }} [dirs]
 * @returns {http.Server}
 */
export function createServer({ publicDir = path.join(ROOT, 'public'), tabsDir = path.join(ROOT, 'tabs') } = {}) {
  return http.createServer((req, res) => {
    handle(req, res, { publicDir, tabsDir }).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    });
  });
}

async function handle(req, res, { publicDir, tabsDir }) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/tabs') {
    if (req.method === 'GET') return sendJson(res, 200, await listTabs(tabsDir));
    if (req.method === 'POST') return sendJson(res, 200, await uploadTab(req, searchParams.get('name'), tabsDir));
    throw new HttpError(405, 'Method not allowed.');
  }

  if (pathname.startsWith('/api/tabs/')) {
    const file = path.join(tabsDir, tabName(pathname.slice('/api/tabs/'.length)));
    if (req.method === 'GET') {
      await requireTab(file);
      const data = await fs.readFile(file);
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/plain',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return;
    }
    if (req.method === 'DELETE') {
      await requireTab(file);
      await fs.unlink(file);
      res.writeHead(204, BASE_HEADERS);
      res.end();
      return;
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  await sendStatic(req, res, pathname, publicDir);
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function sendStatic(req, res, pathname, publicDir) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path.');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.join(publicDir, relative);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type || relative.includes('\0') || !file.startsWith(publicDir + path.sep)) {
    throw new HttpError(404, 'Not found.');
  }
  let data;
  try {
    data = await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') throw new HttpError(404, 'Not found.');
    throw err;
  }
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function listTabs(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const tabs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeName(entry.name)) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    tabs.push({ name: entry.name, size: stat.size, modified: Math.round(stat.mtimeMs) });
  }
  // By name without the extension, so that "riff.tab" comes before "riff-2.tab".
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const stem = (name) => name.slice(0, name.length - path.extname(name).length);
  return tabs.sort(
    (a, b) => collator.compare(stem(a.name), stem(b.name)) || collator.compare(a.name, b.name),
  );
}

// A name taken from the URL may only point at a file directly inside the
// tabs folder. Files copied into the folder by hand are fine too, so this
// is looser than cleanName().
function isSafeName(name) {
  return name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name) && !name.startsWith('.');
}

function tabName(encoded) {
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'Bad file name.');
  }
  if (!isSafeName(name)) throw new HttpError(404, 'No such tab.');
  return name;
}

// Only ordinary files count as tabs: no folders, and no links leading elsewhere.
async function requireTab(file) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new HttpError(404, 'No such tab.');
    throw err;
  }
  if (!stat.isFile()) throw new HttpError(404, 'No such tab.');
}

/**
 * Turns the name of an uploaded file into a tidy one that is safe to store.
 * @param {string|null} raw
 * @returns {string}
 */
export function cleanName(raw) {
  let name = String(raw ?? '')
    .normalize('NFC')
    .split(/[/\\]/)
    .pop()
    .replace(/[^\p{L}\p{N} ._()'&,+-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim();
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length).trim() + ext;
  }
  return name || 'untitled.tab';
}

async function uploadTab(req, rawName, dir) {
  // A page on another site can post plain text here without asking, but
  // not this content type.
  if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Send the file as application/octet-stream.');
  }
  const name = cleanName(rawName);
  const data = await readBody(req, MAX_UPLOAD_BYTES);
  if (data.length === 0) throw new HttpError(400, 'The file is empty.');
  if (data.includes(0)) throw new HttpError(415, 'This does not look like a text file.');
  await fs.mkdir(dir, { recursive: true });
  return storeTab(dir, name, data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      reject(new HttpError(413, 'The file is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        reject(new HttpError(413, 'The file is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Never overwrites: the same file uploaded again is left alone, and a
// different file under a taken name is stored as "name-2.tab".
async function storeTab(dir, name, data) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${base}-${n}${ext}`;
    const file = path.join(dir, candidate);
    try {
      await fs.writeFile(file, data, { flag: 'wx' });
      return { name: candidate, created: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const stat = await fs.lstat(file);
    if (stat.isFile() && (await fs.readFile(file)).equals(data)) return { name: candidate, created: false };
  }
  throw new HttpError(409, 'Too many tabs with this name.');
}

function lanAddresses() {
  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr)/.test(name)) continue;
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  return addresses;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5678;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the other program or start with PORT=<number>.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log('Guitar Tabs is running:');
    if (host === '0.0.0.0' || host === '::') {
      console.log(`  http://localhost:${port}`);
      for (const address of lanAddresses()) console.log(`  http://${address}:${port}`);
    } else {
      console.log(`  http://${host}:${port}`);
    }
  });
}
