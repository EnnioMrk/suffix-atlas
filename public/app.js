const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const number = new Intl.NumberFormat('en-GB');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function apiBase() {
  let directory = window.location.pathname;
  if (!directory.endsWith('/')) {
    const last = directory.split('/').pop() || '';
    directory = last.includes('.') ? directory.slice(0, directory.lastIndexOf('/') + 1) : `${directory}/`;
  }
  return `${directory}api/`;
}

const API = apiBase();
const termInput = $('#term');
const searchForm = $('#search-form');
const formError = $('#form-error');
const scanButton = $('.scan-button');
const buttonLabel = $('.button-label');
const stage = $('#stage');
const results = $('#results');
const resultsBody = $('#results-body');
const tableWrap = $('#table-wrap');
const emptyResults = $('#empty-results');
const wildcardNote = $('#wildcard-note');
const emptyTitle = $('#empty-title');
const emptyText = $('#empty-text');
const emptyAction = $('#empty-action');
const downloadButton = $('#download');
const tabs = $$('.tab');
const methodDialog = $('#method-dialog');

const state = {
  meta: null,
  term: '',
  jobId: null,
  scanning: false,
  pollTimer: null,
  pollFailures: 0,
  results: [],
  summary: null,
  activeTab: 'direct',
};

const field = {
  canvas: $('#suffix-field'),
  wrap: $('#field-wrap'),
  ctx: null,
  total: 1666,
  checked: 0,
  target: 0,
  marks: new Set(),
  directMarks: new Set(),
  complete: false,
  layout: null,
  raf: 0,
};

const CATEGORY_LABEL = {
  direct: 'No redirect',
  canonical: 'Live after redirect',
  external: 'Redirects away',
  insecure: 'HTTP only',
  blocked: 'Blocked',
  missing: 'Not found',
  error: 'No answer',
  dns: 'No site',
};

function formatNumber(value) {
  return number.format(Number(value) || 0);
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function setError(message) {
  if (message) {
    formError.textContent = message;
    formError.hidden = false;
    termInput.setAttribute('aria-invalid', 'true');
  } else {
    formError.textContent = '';
    formError.hidden = true;
    termInput.removeAttribute('aria-invalid');
  }
}

function validateTerm(value) {
  const term = value.trim().toLowerCase();
  if (!term) return { error: 'Enter a word to scan.' };
  if (term.length > 63) return { error: 'Keep the word to 63 characters or fewer.' };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(term)) {
    return { error: 'Use one word: letters, numbers, or hyphens. No spaces or dots.' };
  }
  return { term };
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    signal: AbortSignal.timeout(18000),
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The error below carries a useful status even if the body is not JSON.
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed with ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadMeta() {
  try {
    const meta = await request('meta');
    state.meta = meta;
    $('#root-count').textContent = `${formatNumber(meta.tlds)} TLDs in the root`;
    $('#scan-total').textContent = formatNumber(meta.total);
    $$('.method-total').forEach((element) => {
      element.textContent = formatNumber(meta.total);
    });
    $('#index-updated').textContent = meta.fetchedAt
      ? `Index from ${new Date(meta.fetchedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'IANA root index';
    field.total = meta.total;
    $('#stat-total').textContent = `/ ${formatNumber(meta.total)}`;
    resizeField();
  } catch {
    $('#index-updated').textContent = 'IANA root index';
  }
}

function setScanning(isScanning) {
  state.scanning = isScanning;
  scanButton.disabled = isScanning;
  buttonLabel.textContent = isScanning ? 'Scanning' : 'Scan';
  stage.setAttribute('aria-busy', String(isScanning));
  document.body.classList.toggle('is-scanning', isScanning);
  if (isScanning) {
    document.body.classList.remove('is-complete', 'is-error');
  }
}

function startFieldAnimation() {
  if (!field.raf) field.raf = requestAnimationFrame(tickField);
}

function setFieldState({ total, target, marks, directMarks, complete }) {
  if (typeof total === 'number') field.total = total;
  if (typeof target === 'number') field.target = Math.min(total ?? field.total, target);
  if (marks) field.marks = marks;
  if (directMarks) field.directMarks = directMarks;
  if (typeof complete === 'boolean') field.complete = complete;
  if (reduceMotion.matches) field.checked = field.target;
  startFieldAnimation();
}

function tickField() {
  field.raf = 0;
  const difference = field.target - field.checked;
  if (Math.abs(difference) > 0.4) {
    field.checked += difference * 0.2;
  } else {
    field.checked = field.target;
  }
  drawField();
  if (Math.abs(field.target - field.checked) > 0.4) {
    field.raf = requestAnimationFrame(tickField);
  }
}

function layoutField() {
  const rect = field.wrap.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const total = Math.max(1, field.total);
  const aspect = width / height;
  let columns = Math.ceil(Math.sqrt(total * aspect));
  columns = Math.max(1, Math.min(columns, total));
  const rows = Math.ceil(total / columns);
  const pitchX = width / columns;
  const pitchY = height / rows;
  const dot = Math.max(1.3, Math.min(pitchX, pitchY) * 0.46);
  field.layout = {
    width,
    height,
    columns,
    rows,
    pitchX,
    pitchY,
    dot,
    offsetX: (width - columns * pitchX) / 2 + pitchX / 2,
    offsetY: (height - rows * pitchY) / 2 + pitchY / 2,
  };
}

function resizeField() {
  const canvas = field.canvas;
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = field.wrap.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  field.ctx = canvas.getContext('2d');
  field.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutField();
  drawField();
}

function drawField() {
  const ctx = field.ctx;
  const layout = field.layout;
  if (!ctx || !layout) return;
  const { width, height, columns, pitchX, pitchY, dot, offsetX, offsetY } = layout;
  ctx.clearRect(0, 0, width, height);

  const pale = '#c8bdab';
  const checked = '#746457';
  const found = '#3f6b37';
  const direct = '#2f5229';
  const total = field.total;
  const checkedCount = field.checked;

  for (let index = 0; index < total; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = offsetX + column * pitchX;
    const y = offsetY + row * pitchY;
    let color = pale;
    let size = dot;
    if (field.directMarks.has(index)) {
      color = direct;
      size = dot * 1.55;
    } else if (field.marks.has(index)) {
      color = found;
      size = dot * 1.25;
    } else if (index < checkedCount) {
      color = checked;
    }
    ctx.fillStyle = color;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }

  const remaining = Math.max(0, total - Math.round(checkedCount));
  field.canvas.setAttribute(
    'aria-label',
    `${formatNumber(Math.round(checkedCount))} of ${formatNumber(total)} suffixes checked; ${formatNumber(field.marks.size)} resolve.${field.complete ? ' Scan complete.' : ''}`,
  );
  field.canvas.dataset.remaining = String(remaining);
}

function updateStage(job) {
  const total = job.total || field.total;
  const isDns = job.phase === 'dns';
  const isWildcard = job.phase === 'wildcard';
  const isProbe = job.phase === 'probe';
  const target = isDns ? job.checked : total;
  const checked = isDns ? job.checked : total;
  const probeProgress = job.probeTotal ? job.probed / job.probeTotal : 1;
  const wildcardProgress = job.wildcardTotal ? job.wildcardChecked / job.wildcardTotal : 1;
  let progress = 0;
  if (job.status === 'done') progress = 1;
  else if (isDns) progress = 0.64 * (checked / Math.max(1, total));
  else if (isWildcard) progress = 0.64 + 0.1 * wildcardProgress;
  else if (isProbe) progress = 0.74 + 0.26 * probeProgress;

  setFieldState({
    total,
    target,
    marks: new Set(job.marks || []),
    complete: job.status === 'done',
  });

  $('#stat-checked').textContent = formatNumber(checked);
  $('#stat-total').textContent = `/ ${formatNumber(total)}`;
  $('#stat-found').textContent = formatNumber(job.found);
  $('#stat-direct').textContent = job.summary ? formatNumber(job.summary.direct) : '—';
  $('#progress-fill').style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  $('#state-label').textContent = job.status === 'done' ? 'Complete' : 'Scanning';
  $('#phase-line').textContent = job.status === 'done'
    ? `Complete in ${formatDuration(job.summary?.elapsedMs)}`
    : isDns
      ? 'Resolving DNS'
      : isWildcard
        ? 'Checking wildcards'
        : 'Testing HTTPS';

  const samples = (job.sample || []).slice(0, 4);
  $('#sample-line').textContent = samples.length
    ? `Found ${samples.join(' · ')}`
    : `Looking for ${job.term} across every suffix.`;
}

function finishScan(job) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.scanning = false;
  state.jobId = null;
  state.results = Array.isArray(job.results) ? job.results : [];
  state.summary = job.summary;
  state.activeTab = 'direct';
  setScanning(false);
  document.body.classList.remove('is-scanning');
  document.body.classList.add('is-complete', 'has-results');
  stage.setAttribute('aria-busy', 'false');

  const summary = job.summary || {
    found: state.results.length,
    direct: 0,
    canonical: 0,
    external: 0,
    answered: 0,
    redirects: 0,
    live: 0,
    elapsedMs: 0,
    wildcards: 0,
  };

  const directMarks = new Set(
    state.results.filter((result) => result.category === 'direct').map((result) => result.suffixIndex),
  );
  setFieldState({
    total: job.total,
    target: job.total,
    marks: new Set(job.marks || []),
    directMarks,
    complete: true,
  });
  $('#stat-checked').textContent = formatNumber(job.total);
  $('#stat-total').textContent = `/ ${formatNumber(job.total)}`;
  $('#stat-found').textContent = formatNumber(summary.found);
  $('#stat-direct').textContent = formatNumber(summary.direct);
  $('#progress-fill').style.width = '100%';
  $('#state-label').textContent = 'Complete';
  $('#phase-line').textContent = `Complete in ${formatDuration(summary.elapsedMs)}`;
  $('#sample-line').textContent = summary.found
    ? `${formatNumber(summary.found)} resolve · ${formatNumber(summary.direct)} direct`
    : 'No names resolve in this suffix index.';

  $('#result-term').textContent = job.term;
  $('#results-count').textContent = `${formatNumber(summary.found)} address${summary.found === 1 ? '' : 'es'}`;
  $('#results-summary').textContent = summary.found
    ? `${formatNumber(summary.direct)} direct · ${formatNumber(summary.canonical)} live after redirect · ${formatNumber(summary.external)} redirect away · scan took ${formatDuration(summary.elapsedMs)}`
    : `${formatNumber(job.total)} suffixes checked · no names resolve for “${job.term}”`;
  if (summary.wildcards > 0) {
    wildcardNote.hidden = false;
    wildcardNote.textContent = `${formatNumber(summary.wildcards)} wildcard suffix${summary.wildcards === 1 ? '' : 'es'} skipped: they resolve every name, so they are not sites.`;
  } else {
    wildcardNote.hidden = true;
    wildcardNote.textContent = '';
  }
  $('#count-direct').textContent = formatNumber(summary.direct);
  $('#count-reachable').textContent = formatNumber(summary.answered);
  $('#count-redirects').textContent = formatNumber(summary.redirects);
  $('#count-all').textContent = formatNumber(summary.found);
  downloadButton.hidden = summary.found === 0;

  results.hidden = false;
  results.classList.remove('is-revealed');
  requestAnimationFrame(() => {
    results.classList.add('is-revealed');
  });
  setTab('direct', false);

  document.title = `${job.term} · Suffix Atlas`;
  const top = results.getBoundingClientRect().top;
  if (top > window.innerHeight - 160) {
    setTimeout(() => {
      results.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    }, 360);
  }
}

function failScan(message) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.scanning = false;
  state.jobId = null;
  setScanning(false);
  document.body.classList.remove('is-scanning');
  document.body.classList.add('is-error');
  stage.setAttribute('aria-busy', 'false');
  $('#state-label').textContent = 'Stopped';
  $('#phase-line').textContent = 'Scan stopped';
  $('#sample-line').textContent = 'The scan did not finish.';
  setError(message || 'The scan did not finish. Try again.');
  startFieldAnimation();
}

async function runScan(rawTerm, { updateUrl = true } = {}) {
  if (state.scanning) return;
  const validation = validateTerm(rawTerm);
  if (validation.error) {
    setError(validation.error);
    termInput.focus();
    return;
  }
  const term = validation.term;
  setError('');
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.term = term;
  state.jobId = null;
  state.results = [];
  state.summary = null;
  state.activeTab = 'direct';
  state.pollFailures = 0;
  termInput.value = term;
  document.title = `${term} · Suffix Atlas`;
  results.hidden = true;
  results.classList.remove('is-revealed');
  wildcardNote.hidden = true;
  wildcardNote.textContent = '';
  document.body.classList.remove('has-results', 'is-complete', 'is-error');
  document.body.classList.add('is-scanning');
  setScanning(true);
  stage.setAttribute('aria-busy', 'true');
  $('#state-label').textContent = 'Scanning';
  $('#stat-direct').textContent = '—';
  $('#stat-found').textContent = '0';
  $('#stat-checked').textContent = '0';
  $('#stat-total').textContent = `/ ${formatNumber(state.meta?.total || 1666)}`;
  $('#progress-fill').style.width = '0%';
  $('#phase-line').textContent = 'Resolving DNS';
  $('#sample-line').textContent = `Looking for ${term} across every suffix.`;
  setFieldState({ total: state.meta?.total || 1666, target: 0, marks: new Set(), directMarks: new Set(), complete: false });
  field.checked = 0;
  drawField();

  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('q', term);
    window.history.replaceState({}, '', url);
  }

  try {
    const start = await request('search', {
      method: 'POST',
      body: JSON.stringify({ term }),
    });
    state.jobId = start.id;
    field.total = start.total;
    $('#stat-total').textContent = `/ ${formatNumber(start.total)}`;
    pollScan();
  } catch (error) {
    failScan(error.message || 'The scan service did not answer. Try again.');
  }
}

async function pollScan() {
  if (!state.jobId) return;
  try {
    const job = await request(`search/${encodeURIComponent(state.jobId)}`);
    state.pollFailures = 0;
    updateStage(job);
    if (job.status === 'done') {
      finishScan(job);
      return;
    }
    if (job.status === 'error') {
      failScan(job.error || 'The scan stopped unexpectedly.');
      return;
    }
    state.pollTimer = setTimeout(pollScan, 480);
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) {
      failScan(error.message || 'The scan service stopped answering. Try again.');
      return;
    }
    state.pollTimer = setTimeout(pollScan, 900);
  }
}

function shortUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.hostname}${path}${url.search}`;
  } catch {
    return value;
  }
}

function splitDomain(display) {
  const dot = display.indexOf('.');
  if (dot < 1) return { name: display, suffix: '' };
  return { name: display.slice(0, dot), suffix: display.slice(dot) };
}

function answerLabel(result) {
  if (result.category === 'error' && result.status) {
    if (result.status >= 500) return 'Server error';
    if (result.status >= 300) return 'No HTTPS';
    return 'Answered';
  }
  return CATEGORY_LABEL[result.category] || 'Answered';
}

function makeRow(result) {
  const row = document.createElement('tr');
  const domainCell = document.createElement('td');
  const domain = splitDomain(result.display || result.ascii);
  const link = document.createElement('a');
  link.className = 'domain-link';
  link.href = `https://${result.ascii}/`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `Open ${result.display || result.ascii} in a new tab`);
  const name = document.createElement('span');
  name.className = 'domain-name';
  name.textContent = domain.name;
  const suffix = document.createElement('span');
  suffix.className = 'domain-suffix';
  suffix.textContent = domain.suffix;
  const arrow = document.createElement('span');
  arrow.className = 'domain-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '↗';
  link.append(name, suffix, arrow);
  domainCell.append(link);

  const answerCell = document.createElement('td');
  const answer = document.createElement('span');
  answer.className = `answer ${result.category}${result.category === 'error' && result.status ? ' has-status' : ''}`;
  const dot = document.createElement('span');
  dot.className = 'answer-dot';
  dot.setAttribute('aria-hidden', 'true');
  const answerText = document.createElement('span');
  answerText.textContent = answerLabel(result);
  answer.append(dot, answerText);
  answerCell.append(answer);

  const httpCell = document.createElement('td');
  httpCell.className = 'num';
  const code = document.createElement('span');
  code.className = 'http-code';
  code.textContent = result.status ? String(result.status) : '—';
  httpCell.append(code);

  const timeCell = document.createElement('td');
  timeCell.className = 'num';
  const latency = document.createElement('span');
  latency.className = 'latency';
  latency.textContent = result.latencyMs ? `${formatNumber(Math.round(result.latencyMs))} ms` : '—';
  timeCell.append(latency);

  const redirectCell = document.createElement('td');
  const redirect = document.createElement('span');
  redirect.className = 'redirect-cell';
  const target = result.redirectTo || (result.category === 'canonical' ? result.finalUrl : '');
  if (target) {
    const label = document.createElement('span');
    label.textContent = '→ ';
    redirect.append(label, document.createTextNode(shortUrl(target)));
    redirect.title = target;
  } else {
    redirect.textContent = '—';
    redirectCell.classList.add('empty');
  }
  redirectCell.append(redirect);

  row.append(domainCell, answerCell, httpCell, timeCell, redirectCell);
  return row;
}

function resultsFor(tab) {
  switch (tab) {
    case 'direct':
      return state.results.filter((result) => result.category === 'direct');
    case 'reachable':
      return state.results.filter((result) => Boolean(result.status));
    case 'redirects':
      return state.results.filter((result) => result.category === 'canonical' || result.category === 'external');
    default:
      return state.results;
  }
}

function emptyCopy(tab) {
  if (tab === 'direct') {
    if (!state.results.length) {
      return {
        title: 'No names found.',
        text: state.summary?.wildcards
          ? 'No real names resolve. Wildcard suffixes are skipped because they answer every name.'
          : 'None of the suffixes in this index resolve for this word.',
        action: '',
        target: '',
      };
    }
    return {
      title: 'No direct answers.',
      text: 'No name answered directly. Other groups hold redirects, HTTP-only sites, and names that did not answer.',
      action: state.summary?.answered ? 'Show reachable names' : 'Show all found',
      target: state.summary?.answered ? 'reachable' : 'all',
    };
  }
  if (tab === 'reachable') {
    return {
      title: 'No names answered.',
      text: state.results.length
        ? 'The names resolve, but no HTTP response came back.'
        : 'None of the suffixes in this index resolve for this word.',
      action: state.results.length ? 'Show all found' : '',
      target: 'all',
    };
  }
  if (tab === 'redirects') {
    return {
      title: 'No redirects.',
      text: 'No name in this scan left its own address.',
      action: state.summary?.direct ? 'Show direct names' : '',
      target: 'direct',
    };
  }
  return {
    title: 'No names found.',
    text: 'None of the suffixes in this index resolve for this word.',
    action: '',
    target: '',
  };
}

function renderTab() {
  const visible = resultsFor(state.activeTab);
  resultsBody.replaceChildren();
  if (!visible.length) {
    tableWrap.hidden = true;
    emptyResults.hidden = false;
    const copy = emptyCopy(state.activeTab);
    emptyTitle.textContent = copy.title;
    emptyText.textContent = copy.text;
    if (copy.action) {
      emptyAction.hidden = false;
      emptyAction.textContent = copy.action;
      emptyAction.dataset.target = copy.target;
    } else {
      emptyAction.hidden = true;
      emptyAction.dataset.target = '';
    }
    return;
  }

  emptyResults.hidden = true;
  tableWrap.hidden = false;
  const fragment = document.createDocumentFragment();
  for (const result of visible) fragment.append(makeRow(result));
  resultsBody.append(fragment);
}

function setTab(tab, focus = false) {
  if (!['direct', 'reachable', 'redirects', 'all'].includes(tab)) return;
  state.activeTab = tab;
  for (const button of tabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  renderTab();
}

function downloadCsv() {
  if (!state.results.length) return;
  const header = ['domain', 'answer', 'https', 'http_status', 'reachable', 'redirect_to', 'final_url', 'latency_ms'];
  const rows = state.results.map((result) => [
    result.display || result.ascii,
    answerLabel(result),
    result.https ? 'yes' : 'no',
    result.status ?? '',
    result.status ? 'yes' : 'no',
    result.redirectTo || '',
    result.finalUrl || '',
    result.latencyMs ? Math.round(result.latencyMs) : '',
  ]);
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [header, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `suffix-atlas-${state.term || 'scan'}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openMethod() {
  if (typeof methodDialog.showModal === 'function') methodDialog.showModal();
  else methodDialog.setAttribute('open', '');
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  runScan(termInput.value);
});

termInput.addEventListener('input', () => setError(''));

$$('[data-example]').forEach((button) => {
  button.addEventListener('click', () => {
    if (state.scanning) return;
    termInput.value = button.dataset.example;
    runScan(button.dataset.example);
  });
});

$$('[data-method]').forEach((button) => {
  button.addEventListener('click', openMethod);
});

$('#close-method').addEventListener('click', () => methodDialog.close());
methodDialog.addEventListener('click', (event) => {
  if (event.target === methodDialog) methodDialog.close();
});

downloadButton.addEventListener('click', downloadCsv);

tabs.forEach((button, index) => {
  button.addEventListener('click', () => setTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(tabs[nextIndex].dataset.tab, true);
  });
});

emptyAction.addEventListener('click', () => {
  const target = emptyAction.dataset.target;
  if (target) setTab(target, true);
});

window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key !== '/' || methodDialog.open) return;
  const active = document.activeElement;
  const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (typing) return;
  event.preventDefault();
  termInput.focus();
  termInput.select();
});

window.addEventListener('popstate', () => {
  const term = new URLSearchParams(window.location.search).get('q');
  if (term && !state.scanning) {
    termInput.value = term;
    runScan(term, { updateUrl: false });
  }
});

const resizeObserver = new ResizeObserver(() => {
  resizeField();
});
resizeObserver.observe(field.wrap);
window.addEventListener('resize', resizeField);

resizeField();
loadMeta();

const initialTerm = new URLSearchParams(window.location.search).get('q');
if (initialTerm) {
  termInput.value = initialTerm;
  runScan(initialTerm, { updateUrl: false });
} else if (window.matchMedia('(pointer: fine)').matches && window.innerWidth > 700) {
  setTimeout(() => termInput.focus({ preventScroll: true }), 120);
}
