'use strict';

// LiveLink web front end. Deliberately dependency-free: every call goes
// through `api()` to the endpoints this same server already serves, so the
// page cannot promise a behaviour the API does not implement.

const REFRESH_MS = 4000;

const el = (id) => document.getElementById(id);
const toastEl = el('toast');
let toastTimer = null;

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = '';
  }, isError ? 6000 : 2200);
}

async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : payload?.error || payload?.message;
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return payload;
}

const STATE_LABEL = { Playing: 'playing', Starting: 'starting', Error: 'error', Idle: 'idle', Stopping: 'stopping' };
const stateClass = (state) => STATE_LABEL[state] || 'idle';

function title(source) {
  return (source && source.title) || (source && source.url) || 'unknown';
}

async function loadScreens() {
  let screens;
  try {
    screens = (await api('/screens')).screens;
  } catch (error) {
    toast(`Screens unavailable: ${error.message}`, true);
    return;
  }

  const status = await api('/status');
  el('status').textContent = `${status.total_active}/${status.max_streams} active · updated ${new Date().toLocaleTimeString()}`;

  const container = el('screens');
  container.textContent = '';
  for (const screen of screens) {
    let detail;
    try {
      detail = await api(`/channels/${screen.screen}`);
    } catch (error) {
      detail = { error: error.message };
    }
    container.appendChild(renderScreen(screen, detail, status));
  }
}

function renderScreen(screen, detail, status) {
  const card = document.createElement('div');
  card.className = 'card';

  const state = screen.state || 'Idle';
  const head = document.createElement('div');
  head.className = 'row';
  head.innerHTML = `<span class="title">Screen ${screen.screen}</span>`;
  const badge = document.createElement('span');
  badge.className = `state ${stateClass(state)}`;
  badge.textContent = STATE_LABEL[state] || state;
  head.appendChild(badge);
  card.appendChild(head);

  const now = document.createElement('div');
  now.className = detail.current ? 'now' : 'now none';
  now.textContent = detail.current ? title(detail.current) : 'nothing playing';
  card.appendChild(now);

  const queue = document.createElement('div');
  queue.className = 'queue';
  const entries = (detail.queue || []).slice(0, 4);
  if (detail.error) {
    queue.innerHTML = `<div class="q muted">${detail.error}</div>`;
  } else if (!entries.length) {
    queue.innerHTML = '<div class="q muted">queue empty</div>';
  } else {
    entries.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'q';
      row.textContent = title(item);
      queue.appendChild(row);
    });
  }
  card.appendChild(queue);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const busy = status.total_active >= status.max_streams;

  const button = (label, handler, options = {}) => {
    const node = document.createElement('button');
    node.textContent = label;
    node.disabled = Boolean(options.disabled);
    node.title = options.title || '';
    node.addEventListener('click', handler);
    actions.appendChild(node);
    return node;
  };

  button(`Play ${detail.current ? 'again' : 'next'}`, () => act({ screen: screen.screen }, `/stream/start`, `start screen ${screen.screen}`), {
    disabled: busy,
    title: busy ? 'max concurrent streams reached' : 'dequeue the next item',
  });
  button('Stop', () => act({ screen: screen.screen }, '/stream/stop', `stop screen ${screen.screen}`));
  button('Next', () => act({ screen: screen.screen }, '/channel/next', `next on screen ${screen.screen}`));
  button('Prev', () => act({ screen: screen.screen }, '/channel/prev', `previous on screen ${screen.screen}`));
  button('Transcribe', () => {
    const url = detail.current?.url;
    if (!url) return toast('nothing playing to transcribe', true);
    return act({ screen: screen.screen, url }, '/transcribe', `transcribe ${title(detail.current)}`);
  });
  card.appendChild(actions);
  return card;
}

function act(body, path, label) {
  return api(path, body)
    .then(() => toast(`${label}: ok`))
    .then(loadScreens)
    .catch((error) => toast(`${label}: ${error.message}`, true));
}

async function loadStreams() {
  let byPlatform;
  try {
    byPlatform = await api('/streams');
  } catch (error) {
    el('streams').textContent = `Streams unavailable: ${error.message}`;
    return;
  }

  const card = el('streams');
  card.textContent = '';
  const targets = document.createElement('div');
  targets.className = 'actions';
  const select = document.createElement('select');
  select.innerHTML = '';
  let screens = [];
  try {
    screens = (await api('/screens')).screens;
  } catch {
    screens = [];
  }
  if (screens.length) {
    for (const screen of screens) {
      const option = document.createElement('option');
      option.value = String(screen.screen);
      option.textContent = `screen ${screen.screen}`;
      select.appendChild(option);
    }
  } else {
    select.innerHTML = '<option value="0">screen 0</option>';
    select.value = '0';
  }
  const label = document.createElement('span');
  label.className = 'muted';
  label.textContent = 'play on';
  targets.append(label, select);
  card.appendChild(targets);

  const table = document.createElement('table');
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>channel</th><th class="muted">platform</th><th>title</th><th><a href="#" data-action="refresh">refresh</a></th></tr>';
  head.querySelector('a').addEventListener('click', (event) => {
    event.preventDefault();
    api('/refresh', {}).then(() => toast('refreshing')).then(loadStreams).catch((e) => toast(`refresh: ${e.message}`, true));
  });
  table.appendChild(head);
  const body = document.createElement('tbody');
  let count = 0;
  for (const [platform, items] of Object.entries(byPlatform || {})) {
    for (const item of items.slice(0, 40)) {
      const row = document.createElement('tr');
      row.innerHTML = `<td class="ellipsis">${escapeHtml(item.channel || '—')}</td><td class="muted">${escapeHtml(platform)}</td><td class="ellipsis">${escapeHtml(title(item))}</td>`;
      const cell = document.createElement('td');
      const play = document.createElement('button');
      play.textContent = 'play';
      play.addEventListener('click', () =>
        act({ screen: Number(select.value), url: item.url }, '/channel/play', `play ${title(item)}`)
      );
      cell.appendChild(play);
      row.appendChild(cell);
      body.appendChild(row);
      count += 1;
    }
  }
  table.appendChild(body);
  card.appendChild(table);
  if (!count) card.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'no streams cached yet' }));
}

// Every external field (titles, channels, platforms) is rendered through
// here, so the map must hold real HTML entities, not the characters
// themselves: a channel named "<img onerror=...>" must stay text.
const HTML_ENTITIES = {
  ampersand: '&' + 'amp;',
  lessThan: '&' + 'lt;',
  greaterThan: '&' + 'gt;',
  doubleQuote: '&' + 'quot;',
  apostrophe: '&' + 'apos;',
};

function escapeHtml(value) {
  const text = String(value ?? '');
  const lookup = {
    '&': HTML_ENTITIES.ampersand,
    '<': HTML_ENTITIES.lessThan,
    '>': HTML_ENTITIES.greaterThan,
    '"': HTML_ENTITIES.doubleQuote,
    "'": HTML_ENTITIES.apostrophe,
  };
  return text.replace(/[&<>"']/g, (character) => lookup[character]);
}

el('refresh').addEventListener('click', () => {
  Promise.allSettled([loadScreens(), loadStreams()]);
});

(async function start() {
  await Promise.allSettled([loadScreens(), loadStreams()]);
  setInterval(loadScreens, REFRESH_MS);
})();