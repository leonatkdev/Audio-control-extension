import {
  DEFAULT_SETTINGS,
  canScript,
  getReasons,
  getSettings,
  mediaAction,
  saveSettings,
  setTabMuted,
  siteOf,
  siteRuleFor,
  togglePlay,
} from '../lib/media.js';

const svg = (body, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  play: svg('<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" stroke="none"/>', true),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" stroke="none"/>', true),
  back: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  fwd: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  sound: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  muted: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
  micOff: svg('<path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M19 10v2a7 7 0 0 1-.9 3.4"/><path d="M5 10v2a7 7 0 0 0 11.8 5.1"/><path d="M12 19v3"/>'),
  cam: svg('<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
  camOff: svg('<path d="m2 2 20 20"/><path d="M16 16v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2"/><path d="M9.7 6H15a1 1 0 0 1 1 1v3.3l1 1 5-3.3v8"/>'),
};

const RATES = [1, 1.25, 1.5, 2, 0.75];
const MAX_BOOST = 300; // percent

const $ = (sel, root = document) => root.querySelector(sel);
const ui = {
  list: $('#tabs'),
  empty: $('#empty'),
  summary: $('#summary'),
  search: $('#search'),
  emptyTitle: $('#emptyTitle'),
  emptyText: $('#emptyText'),
  muteAll: $('#muteAll'),
  showAll: $('#showAll'),
  siteList: $('#siteList'),
  siteCount: $('#siteCount'),
  addSite: $('#addSite'),
  keyList: $('#keyList'),
  tpl: $('#tab-tpl'),
};

let tabs = [];
let media = new Map(); // tabId -> media summary
let reasons = {};
let settings = { ...DEFAULT_SETTINGS };
let activeTabId = null;
let scanned = false;
let dragging = false;
let settingsOpen = false;
let query = '';
let lastSignature = '';

// ---- Data ----

async function loadTabs() {
  const [all, [active], why] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
    getReasons(),
  ]);
  tabs = all;
  activeTabId = active?.id ?? null;
  reasons = why;
}

async function scanMedia() {
  const entries = await Promise.all(
    tabs.filter(canScript).map(async (t) => [t.id, await mediaAction(t.id, 'state')]),
  );
  media = new Map(entries.filter(([, m]) => m));
  scanned = true;
}

let refreshing = null;
let refreshAgain = false;
async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await loadTabs();
      render(); // fast first paint from tab info alone
      await scanMedia();
      render();
    } while (refreshAgain);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

let refreshTimer;
function scheduleRefresh(delay = 150) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

// Re-read a single tab right after acting on it, then settle everything a bit later
// (Chrome updates a tab's "audible" flag with a short delay).
async function refreshTab(tabId) {
  try {
    const [tab, m, why] = await Promise.all([
      chrome.tabs.get(tabId),
      mediaAction(tabId, 'state'),
      getReasons(),
    ]);
    tabs = tabs.map((t) => (t.id === tabId ? tab : t));
    if (m) media.set(tabId, m);
    reasons = why;
    render();
  } catch {
    // tab closed
  }
  scheduleRefresh(700);
}

// ---- Rendering ----

const hasMedia = (t) => media.get(t.id)?.count > 0;
const isMuted = (t) => !!t.mutedInfo?.muted;

// Every word of the query must appear in the tab's title or URL.
const matchesQuery = (t) => {
  const haystack = `${t.title ?? ''} ${t.url ?? ''}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
};

function visibleTabs() {
  // A search looks through every tab, even when only tabs with sound are listed.
  const shown = query
    ? tabs.filter(matchesQuery)
    : tabs.filter((t) => settings.showAll || t.audible || isMuted(t) || hasMedia(t));
  const rank = (t) => {
    if (t.audible && !isMuted(t)) return 0;
    if (media.get(t.id)?.playing) return 1;
    if (isMuted(t)) return 2;
    if (hasMedia(t)) return 3;
    return 4;
  };
  return shown.sort((a, b) => rank(a) - rank(b) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

function statusOf(t) {
  const m = media.get(t.id);
  const playing = t.audible || m?.playing;
  if (isMuted(t)) {
    const why = reasons[t.id];
    const base = playing ? 'Muted · playing' : 'Muted';
    if (why === 'rule') return `${base} (always-muted site)`;
    return base;
  }
  if (playing) return 'Playing';
  if (m?.count) return 'Paused';
  return '';
}

function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url || '');
  u.searchParams.set('size', '32');
  return u.toString();
}

function render() {
  if (dragging) return;

  const shown = visibleTabs();
  const signature = JSON.stringify([
    shown.map((t) => [t.id, t.title, t.url, t.audible, isMuted(t), reasons[t.id], media.get(t.id)]),
    activeTabId,
    settings,
    query,
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  ui.list.replaceChildren(...shown.map(renderTab));
  ui.empty.hidden = shown.length > 0 || !scanned;
  ui.emptyTitle.textContent = query ? 'No matching tabs' : 'Nothing is playing';
  ui.emptyText.textContent = query
    ? 'Try a different word, site or part of the URL.'
    : 'Tabs with sound, video or audio will show up here.';

  const playing = tabs.filter((t) => t.audible && !isMuted(t)).length;
  const muted = tabs.filter(isMuted).length;
  ui.summary.textContent =
    [playing && `${playing} playing`, muted && `${muted} muted`].filter(Boolean).join(' · ') ||
    (scanned ? 'All quiet' : 'Scanning tabs…');
  renderMuteAll();

  renderSettings();
}

function renderTab(t) {
  const node = ui.tpl.content.firstElementChild.cloneNode(true);
  const m = media.get(t.id);
  const muted = isMuted(t);
  const site = siteOf(t.url);
  const isMeet = site === 'meet.google.com';
  const withMedia = m?.count > 0;
  const btn = (act) => $(`[data-act="${act}"]`, node);

  node.classList.toggle('active', t.id === activeTabId);
  node.classList.toggle('sounding', !!t.audible && !muted);

  $('.fav', node).src = favicon(t.url);
  $('.title', node).textContent = t.title || t.url;
  $('.meta', node).textContent = [site ?? 'Browser page', statusOf(t)].filter(Boolean).join(' · ');
  $('.open', node).addEventListener('click', () => goTo(t));

  // Transport controls (not for Meet, where "pausing" would cut the call audio).
  const transport = withMedia && !isMeet;
  for (const act of ['back', 'play', 'fwd']) btn(act).hidden = !transport;
  btn('back').innerHTML = ICON.back;
  btn('fwd').innerHTML = ICON.fwd;
  btn('back').addEventListener('click', act(t, () => mediaAction(t.id, 'seek', -10)));
  btn('fwd').addEventListener('click', act(t, () => mediaAction(t.id, 'seek', 10)));

  const play = btn('play');
  play.innerHTML = m?.playing ? ICON.pause : ICON.play;
  play.title = m?.playing ? 'Pause' : 'Play';
  play.addEventListener('click', act(t, () => togglePlay(t.id)));

  const mute = btn('mute');
  mute.innerHTML = muted ? ICON.muted : ICON.sound;
  mute.title = muted ? 'Unmute tab' : 'Mute tab';
  mute.classList.toggle('on', muted);
  mute.setAttribute('aria-pressed', String(muted));
  mute.addEventListener('click', act(t, () => setTabMuted(t.id, !muted)));

  // Volume
  const vol = $('.vol', node);
  vol.hidden = !withMedia;
  if (withMedia) {
    const range = $('input', vol);
    const out = $('output', vol);
    const pct = Math.round((m.volume ?? 1) * 100);
    // Pages where boosting would go silent keep the slider at 100% max.
    range.max = m.boostable || pct > 100 ? MAX_BOOST : 100;
    range.value = pct;
    const show = (v) => {
      out.textContent = `${v}%`;
      vol.classList.toggle('boosted', v > 100);
      vol.title = v > 100 ? 'Volume boosted above 100%' : 'Page volume';
    };
    show(pct);
    const apply = throttle((v) => mediaAction(t.id, 'volume', v / 100), 60);
    range.addEventListener('pointerdown', () => (dragging = true));
    range.addEventListener('input', () => {
      const v = Number(range.value);
      show(v);
      m.volume = v / 100;
      apply(v);
    });
  }

  // Playback speed
  const rate = btn('rate');
  rate.hidden = !transport;
  rate.textContent = `${m?.rate ?? 1}×`;
  rate.addEventListener(
    'click',
    act(t, () => {
      const next = RATES[(RATES.indexOf(m.rate) + 1) % RATES.length];
      return mediaAction(t.id, 'rate', next);
    }),
  );

  // Google Meet mic / camera
  for (const kind of ['mic', 'cam']) {
    const chip = btn(`meet-${kind}`);
    const state = m?.meet?.[kind];
    chip.hidden = !state;
    if (!state) continue;
    const off = state === 'off';
    const label = kind === 'mic' ? 'Mic' : 'Camera';
    chip.innerHTML = `${ICON[kind + (off ? 'Off' : '')]}${label} ${off ? 'off' : 'on'}`;
    chip.classList.toggle('off', off);
    chip.title = `Turn ${label.toLowerCase()} ${off ? 'on' : 'off'} in Meet`;
    chip.addEventListener('click', act(t, () => mediaAction(t.id, `meet-${kind}`), 350));
  }

  // Always mute this site
  const rule = btn('rule');
  const matched = site && siteRuleFor(t.url, settings.mutedSites);
  rule.hidden = !site;
  rule.textContent = matched ? `Always muted ✓` : 'Always mute site';
  rule.title = matched ? `Stop auto-muting ${matched}` : `Mute ${site} in every tab, now and later`;
  rule.setAttribute('aria-pressed', String(!!matched));
  rule.addEventListener('click', () =>
    setMutedSites(
      matched ? settings.mutedSites.filter((s) => s !== matched) : [site, ...settings.mutedSites],
    ),
  );

  $('.more', node).hidden = [...$('.more', node).children].every((c) => c.hidden);
  return node;
}

function renderSettings() {
  ui.showAll.checked = settings.showAll;

  const sites = settings.mutedSites;
  ui.siteCount.textContent = sites.length ? `(${sites.length})` : '';
  ui.siteList.replaceChildren(
    ...(sites.length
      ? sites.map((s) => {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.textContent = s;
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.textContent = 'Remove';
          remove.title = `Stop auto-muting ${s}`;
          remove.addEventListener('click', () => setMutedSites(sites.filter((x) => x !== s)));
          li.append(name, remove);
          return li;
        })
      : [Object.assign(document.createElement('li'), { className: 'hint', textContent: 'No sites yet.' })]),
  );
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  ui.keyList.replaceChildren(
    ...commands
      .filter((c) => c.description)
      .map((c) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = c.description;
        const key = document.createElement(c.shortcut ? 'kbd' : 'span');
        key.textContent = c.shortcut || 'Not set';
        if (!c.shortcut) key.className = 'hint';
        li.append(label, key);
        return li;
      }),
  );
}

// ---- Actions ----

// Wraps a per-tab action: run it, then re-read that tab.
function act(tab, fn, settleMs = 0) {
  return async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    await fn();
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    await refreshTab(tab.id);
    button.disabled = false; // in case nothing changed and the row wasn't re-rendered
  };
}

async function goTo(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

async function setMutedSites(mutedSites) {
  settings.mutedSites = mutedSites;
  render();
  await saveSettings({ mutedSites }); // the background worker applies the change to open tabs
}

const soundTabs = () => tabs.filter((t) => t.audible || hasMedia(t));

// One header button: "Mute all" while anything can still be heard, otherwise "Unmute all".
const muteAllMode = () =>
  soundTabs().some((t) => !isMuted(t)) ? 'mute' : tabs.some(isMuted) ? 'unmute' : null;

function renderMuteAll() {
  const mode = muteAllMode();
  ui.muteAll.hidden = !mode || settingsOpen;
  if (!mode) return;
  ui.muteAll.innerHTML = mode === 'mute' ? `${ICON.muted}Mute all` : `${ICON.sound}Unmute all`;
  ui.muteAll.classList.toggle('unmute', mode === 'unmute');
}

ui.muteAll.addEventListener('click', async () => {
  const mode = muteAllMode();
  ui.muteAll.disabled = true;
  if (mode === 'mute') await Promise.all(soundTabs().map((t) => setTabMuted(t.id, true)));
  if (mode === 'unmute') await Promise.all(tabs.filter(isMuted).map((t) => setTabMuted(t.id, false)));
  ui.muteAll.disabled = false;
  await refresh();
  scheduleRefresh(700);
});

ui.showAll.addEventListener('change', async () => {
  settings.showAll = ui.showAll.checked;
  render();
  await saveSettings({ showAll: settings.showAll });
});

ui.addSite.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = ui.addSite.elements.site;
  const site = normalizeSite(input.value);
  if (!site) {
    input.setCustomValidity('Enter a site like example.com');
    input.reportValidity();
    return;
  }
  input.value = '';
  if (!settings.mutedSites.includes(site)) setMutedSites([site, ...settings.mutedSites]);
});
ui.addSite.elements.site.addEventListener('input', (e) => e.target.setCustomValidity(''));

// ---- Search ----

ui.search.addEventListener('input', () => {
  query = ui.search.value.trim().toLowerCase();
  render();
  $('main').scrollTop = 0;
});

// Enter jumps to the first result.
ui.search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const [first] = visibleTabs();
  if (first) goTo(first);
});

// ---- Views ----

function showSettings(open) {
  settingsOpen = open;
  renderMuteAll();
  $('#listView').hidden = open;
  $('#settingsView').hidden = !open;
  $('#back').hidden = !open;
  $('.logo').hidden = open;
  $('#openSettings').hidden = open;
  $('#summary').hidden = open;
  $('#viewTitle').textContent = open ? 'Settings' : 'Audio Control';
  (open ? $('#back') : $('#openSettings')).focus();
}

$('#openSettings').addEventListener('click', () => showSettings(true));
$('#back').addEventListener('click', () => showSettings(false));

$('#editKeys').addEventListener('click', () =>
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
);

function normalizeSite(value) {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
    return host.includes('.') || host === 'localhost' ? host : null;
  } catch {
    return null;
  }
}

function throttle(fn, ms) {
  let last = 0;
  let timer;
  return (...args) => {
    clearTimeout(timer);
    const wait = ms - (Date.now() - last);
    const run = () => {
      last = Date.now();
      fn(...args);
    };
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
}

// ---- Live updates ----

window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  scheduleRefresh(300);
});

chrome.tabs.onUpdated.addListener((_id, info) => {
  if ('audible' in info || info.mutedInfo || info.title || info.url || info.status === 'complete') {
    scheduleRefresh();
  }
});
chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
chrome.tabs.onCreated.addListener(() => scheduleRefresh());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULT_SETTINGS) settings[key] = newValue ?? DEFAULT_SETTINGS[key];
    }
    render();
  }
  if (area === 'session' && changes.muteReasons) {
    reasons = changes.muteReasons.newValue ?? {};
    render();
  }
});

// Play/pause inside a page doesn't always change a tab's audible flag right away.
setInterval(() => !dragging && refresh(), 2500);

settings = await getSettings();
renderShortcuts();
refresh();
