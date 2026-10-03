// The page: the list of uploaded tabs, uploading, and showing one tab.

import { parseTab } from './tab-parser.js';
import { renderDocument } from './tab-render.js';

/** @import { TabDocument } from './tab-parser.js' */

// The server refuses anything larger; checking here gives a clearer message.
const MAX_UPLOAD_BYTES = 1024 * 1024;
// Width a staff gets on paper: A4 or Letter, less the page margins.
const PRINT_WIDTH = 680;
const WIDE_SCREEN = window.matchMedia('(min-width: 761px)');

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  list: $('tab-list'),
  libraryEmpty: $('library-empty'),
  welcome: $('welcome'),
  viewer: $('viewer'),
  title: $('sheet-title'),
  notice: $('sheet-notice'),
  body: $('sheet-body'),
  source: $('sheet-source'),
  sourceButton: $('source-button'),
  fileInput: $('file-input'),
  overlay: $('drop-overlay'),
};

/** @type {{ name: string }[]} */
let tabs = [];
/** @type {{ name: string, text: string, doc: TabDocument } | null} */
let current = null;
let showSource = false;
let renderedWidth = 0;
let printing = false;
let statusTimer = 0;

// "blues_licks1.tab" -> "Blues Licks1"
function titleOf(name) {
  const title = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/_+/g, ' ')
    .trim()
    .replace(/(^|\s)\p{Ll}/gu, (match) => match.toUpperCase());
  return title || name;
}

const hashFor = (name) => `#/${encodeURIComponent(name)}`;

function selectedName() {
  try {
    return decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  } catch {
    return '';
  }
}

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
  els.status.hidden = false;
  if (!isError) statusTimer = setTimeout(() => (els.status.hidden = true), 5000);
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('The server could not be reached.');
  }
  if (!response.ok) {
    let message = `The server answered with an error (${response.status}).`;
    try {
      message = (await response.json()).error ?? message;
    } catch {
      // not a JSON answer; keep the general message
    }
    throw new Error(message);
  }
  return response;
}

// Old tab files are often not UTF-8.
function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

async function loadTabs() {
  tabs = await (await request('/api/tabs')).json();
  renderList();
}

function renderList() {
  const selected = selectedName();
  els.list.replaceChildren(
    ...tabs.map((tab) => {
      const link = document.createElement('a');
      link.href = hashFor(tab.name);
      link.textContent = titleOf(tab.name);
      link.title = tab.name;
      if (tab.name === selected) link.setAttribute('aria-current', 'page');
      const item = document.createElement('li');
      item.append(link);
      return item;
    }),
  );
  els.libraryEmpty.hidden = tabs.length > 0;
}

async function route() {
  const name = selectedName();
  renderList();
  if (!name) {
    // With the list beside the sheet there is no reason to show an empty one.
    if (WIDE_SCREEN.matches && tabs.length) {
      location.replace(hashFor(tabs[0].name));
      return;
    }
    current = null;
    show();
    return;
  }
  try {
    const response = await request(`/api/tabs/${encodeURIComponent(name)}`);
    const text = decodeText(await response.arrayBuffer());
    if (selectedName() !== name) return; // another tab was picked while this one loaded
    current = { name, text, doc: parseTab(text) };
  } catch (err) {
    if (selectedName() !== name) return;
    current = null;
    showStatus(`Could not open ${titleOf(name)}. ${err.message}`, true);
  }
  showSource = false;
  show();
  window.scrollTo(0, 0);
}

function show() {
  document.body.dataset.view = current ? 'sheet' : 'library';
  els.viewer.hidden = !current;
  els.welcome.hidden = Boolean(current);
  els.welcome.querySelector('h1').textContent = tabs.length ? 'Pick a tab from the list' : 'Upload your first tab';
  if (!current) {
    document.title = 'Guitar Tabs';
    return;
  }
  const title = titleOf(current.name);
  document.title = `${title} - Guitar Tabs`;
  els.title.textContent = title;
  els.source.textContent = current.text;
  els.source.hidden = !showSource;
  els.body.hidden = showSource;
  els.sourceButton.setAttribute('aria-pressed', String(showSource));
  els.notice.hidden = showSource || current.doc.sections.some((section) => section.type === 'staff');
  renderSheet();
}

function renderSheet(width = els.body.clientWidth) {
  if (!current || showSource || !width) return;
  renderedWidth = width;
  els.body.innerHTML = renderDocument(current.doc, { width });
}

async function uploadFiles(files) {
  const added = [];
  const problems = [];
  for (const file of files) {
    try {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error('The file is too large.');
      const response = await request(`/api/tabs?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      added.push((await response.json()).name);
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
  }
  if (added.length) {
    await loadTabs();
    const target = hashFor(added[0]);
    if (location.hash === target) route();
    else location.hash = target;
  }
  if (problems.length) {
    showStatus(`Could not add ${problems.join(' ')}`, true);
  } else if (added.length) {
    showStatus(added.length === 1 ? `Added ${titleOf(added[0])}.` : `Added ${added.length} tabs.`);
  }
}

async function deleteCurrent() {
  if (!current) return;
  const { name } = current;
  if (!confirm(`Delete "${titleOf(name)}"? The file is removed from the server.`)) return;
  try {
    await request(`/api/tabs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadTabs();
    showStatus(`Deleted ${titleOf(name)}.`);
    location.hash = '#/';
  } catch (err) {
    showStatus(err.message, true);
  }
}

$('upload-button').addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  uploadFiles([...els.fileInput.files]);
  els.fileInput.value = '';
});
$('print-button').addEventListener('click', () => window.print());
$('delete-button').addEventListener('click', deleteCurrent);
els.sourceButton.addEventListener('click', () => {
  showSource = !showSource;
  show();
});
els.status.addEventListener('click', () => (els.status.hidden = true));

// Files dropped anywhere on the page are uploaded.
const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  els.overlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener('dragleave', (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.overlay.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.overlay.hidden = true;
  uploadFiles([...event.dataTransfer.files]);
});

// A staff is laid out for the width it has, so it is drawn again when
// that changes, and once more at paper width for printing.
new ResizeObserver(() => {
  const width = els.body.clientWidth;
  if (!printing && width && width !== renderedWidth) renderSheet(width);
}).observe(els.body);
window.addEventListener('beforeprint', () => {
  printing = true;
  renderSheet(PRINT_WIDTH);
});
window.addEventListener('afterprint', () => {
  printing = false;
  renderSheet();
});

window.addEventListener('hashchange', route);
loadTabs()
  .catch((err) => showStatus(err.message, true))
  .finally(route);
