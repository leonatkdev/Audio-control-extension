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
  dots: svg('<circle cx="5" cy="12" r="1.8" stroke="none"/><circle cx="12" cy="12" r="1.8" stroke="none"/><circle cx="19" cy="12" r="1.8" stroke="none"/>', true),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  saved: svg('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
};

const RATES = [0.75, 1, 1.25, 1.5, 2];
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
  menu: $('#menu'),
  showAll: $('#showAll'),
  siteList: $('#siteList'),
  volumeList: $('#volumeList'),
  volumeCount: $('#volumeCount'),
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
// Tabs that get a full row with controls; the rest are listed compactly under "Other tabs".
const isMediaTab = (t) => t.audible || hasMedia(t);

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

  const focus = captureFocus();
  renderList(shown);
  restoreFocus(focus);

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

function renderList(shown) {
  const mediaTabs = shown.filter(isMediaTab);
  const otherTabs = shown.filter((t) => !isMediaTab(t));
  // Headings only help when there is something to tell apart.
  const both = mediaTabs.length > 0 && otherTabs.length > 0;
  const heading = (text) => {
    const li = document.createElement('li');
    li.className = 'group';
    li.setAttribute('role', 'presentation');
    li.textContent = text;
    return li;
  };
  ui.list.replaceChildren(
    ...(both ? [heading('Media')] : []),
    ...mediaTabs.map(renderTab),
    ...(both ? [heading(`Other tabs · ${otherTabs.length}`)] : []),
    ...otherTabs.map(renderTab),
  );
}

function renderTab(t) {
  const node = ui.tpl.content.firstElementChild.cloneNode(true);
  const m = media.get(t.id);
  const muted = isMuted(t);
  const site = siteOf(t.url);
  const isMeet = site === 'meet.google.com';
  const withMedia = m?.count > 0;
  const compact = !isMediaTab(t);
  const btn = (name) => $(`[data-act="${name}"]`, node);

  node.dataset.tabId = t.id;
  node.classList.toggle('compact', compact);
  node.classList.toggle('active', t.id === activeTabId);
  node.classList.toggle('sounding', !!t.audible && !muted);

  $('.fav', node).src = favicon(t.url);
  $('.title', node).textContent = t.title || t.url;
  $('.status', node).textContent = [site ?? 'Browser page', statusOf(t)].filter(Boolean).join(' · ');
  const open = $('.open', node);
  open.title = compact ? `Go to tab · ${site ?? t.url}` : 'Go to tab';
  open.addEventListener('click', () => goTo(t));

  // Play/pause (not for Meet, where "pausing" would cut the call audio).
  const play = btn('play');
  play.hidden = !withMedia || isMeet;
  play.innerHTML = m?.playing ? ICON.pause : ICON.play;
  play.title = m?.playing ? 'Pause (Space)' : 'Play (Space)';
  play.addEventListener('click', act(t, () => togglePlay(t.id)));

  const mute = btn('mute');
  mute.innerHTML = muted ? ICON.muted : ICON.sound;
  mute.title = muted
    ? reasons[t.id] === 'rule'
      ? 'Unmute tab (M) · this site is always muted'
      : 'Unmute tab (M)'
    : 'Mute tab (M)';
  mute.classList.toggle('on', muted);
  mute.setAttribute('aria-pressed', String(muted));
  mute.addEventListener('click', act(t, () => setTabMuted(t.id, !muted)));

  const menuBtn = btn('menu');
  menuBtn.innerHTML = ICON.dots;
  menuBtn.addEventListener('click', () => toggleMenu(t, menuBtn));

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
    // Remember the level for the site once the slider is released.
    if (site) range.addEventListener('change', () => saveSiteVolume(site, Number(range.value) / 100));

    const savedMark = $('.saved', vol);
    const saved = site ? settings.siteVolumes[site] : undefined;
    savedMark.hidden = saved == null;
    savedMark.innerHTML = ICON.saved;
    savedMark.title = `Remembered for ${site}. Forget it from the ⋯ menu.`;
  }

  // Google Meet mic / camera
  for (const kind of ['mic', 'cam']) {
    const button = btn(`meet-${kind}`);
    const state = m?.meet?.[kind];
    button.hidden = !state;
    if (!state) continue;
    const off = state === 'off';
    const label = kind === 'mic' ? 'microphone' : 'camera';
    button.innerHTML = ICON[kind + (off ? 'Off' : '')];
    button.classList.toggle('on', off);
    button.setAttribute('aria-pressed', String(off));
    button.title = `${off ? 'Turn on' : 'Turn off'} ${label} in Meet`;
    button.addEventListener('click', act(t, () => mediaAction(t.id, `meet-${kind}`), 350));
  }

  const more = $('.more', node);
  more.hidden = compact || [...more.children].every((c) => c.hidden);
  return node;
}

// Re-rendering replaces the rows; put keyboard focus back on the same control.
function captureFocus() {
  const el = document.activeElement;
  const row = el?.closest?.('.tab');
  if (!row || !ui.list.contains(row)) return null;
  const control = el.classList.contains('open') ? 'open' : el.type === 'range' ? 'range' : el.dataset.act;
  return { tabId: row.dataset.tabId, control };
}

function restoreFocus(focus) {
  if (!focus) return;
  const row = ui.list.querySelector(`.tab[data-tab-id="${focus.tabId}"]`);
  if (!row) return;
  const selector =
    focus.control === 'open' ? '.open' : focus.control === 'range' ? 'input[type=range]' : `[data-act="${focus.control}"]`;
  const target = $(selector, row);
  (target && !target.closest('[hidden]') ? target : $('.open', row)).focus({ preventScroll: true });
}

function renderSettings() {
  ui.showAll.checked = settings.showAll;
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.checked = radio.value === settings.theme;
  }

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

  const volumes = Object.entries(settings.siteVolumes).sort(([a], [b]) => a.localeCompare(b));
  ui.volumeCount.textContent = volumes.length ? `(${volumes.length})` : '';
  ui.volumeList.replaceChildren(
    ...(volumes.length
      ? volumes.map(([s, v]) => {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.textContent = s;
          const level = document.createElement('span');
          level.className = 'level';
          level.textContent = `${Math.round(v * 100)}%`;
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.textContent = 'Remove';
          remove.title = `Forget the volume for ${s}`;
          remove.addEventListener('click', () => saveSiteVolume(s, 1));
          li.append(name, level, remove);
          return li;
        })
      : [Object.assign(document.createElement('li'), { className: 'hint', textContent: 'None yet.' })]),
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

// ---- Row menu (⋯) ----

let menuTabId = null;
let menuClosedAt = 0;

function toggleMenu(t, anchor) {
  // Clicking ⋯ while its menu is open: light dismiss already closed it on pointerdown.
  if (menuTabId === t.id && Date.now() - menuClosedAt < 300) return;
  openMenu(t, anchor);
}

function openMenu(t, anchor) {
  const m = media.get(t.id);
  const site = siteOf(t.url);
  const transport = m?.count > 0 && site !== 'meet.google.com';
  const saved = site ? settings.siteVolumes[site] : undefined;
  const rule = site ? siteRuleFor(t.url, settings.mutedSites) : null;

  const close = () => ui.menu.hidePopover();
  const label = (text) => Object.assign(document.createElement('div'), { className: 'menu-label', textContent: text });
  const separator = () => Object.assign(document.createElement('div'), { className: 'menu-sep' });

  const item = (icon, text, run, { danger = false, checked, hint } = {}) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (danger ? ' danger' : '');
    b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
    b.innerHTML = `${icon}<span></span>${checked ? `<span class="check">${ICON.check}</span>` : ''}`;
    b.querySelector('span').textContent = text;
    if (hint) b.append(Object.assign(document.createElement('span'), { className: 'menu-hint', textContent: hint }));
    b.addEventListener('click', () => {
      close();
      runOn(t, run);
    });
    return b;
  };

  // A row of small buttons; `keepOpen` lets you press them repeatedly (skipping).
  const segmented = (buttons, { keepOpen = false, radio = false } = {}) => {
    const row = document.createElement('div');
    row.className = 'segmented';
    for (const { html, title, run, checked } of buttons) {
      const b = document.createElement('button');
      b.innerHTML = html;
      b.title = title;
      b.setAttribute('role', radio ? 'menuitemradio' : 'menuitem');
      if (radio) b.setAttribute('aria-checked', String(!!checked));
      b.addEventListener('click', () => {
        if (!keepOpen) close();
        runOn(t, run);
      });
      row.append(b);
    }
    return row;
  };

  const parts = [];
  if (transport) {
    parts.push(
      label('Skip'),
      segmented(
        [
          { html: `${ICON.back}10s`, title: 'Back 10 seconds', run: () => mediaAction(t.id, 'seek', -10) },
          { html: `${ICON.fwd}10s`, title: 'Forward 10 seconds', run: () => mediaAction(t.id, 'seek', 10) },
        ],
        { keepOpen: true },
      ),
      label('Speed'),
      segmented(
        RATES.map((r) => ({
          html: `${r}×`,
          title: `Play at ${r}× speed`,
          checked: r === m.rate,
          run: () => mediaAction(t.id, 'rate', r),
        })),
        { radio: true },
      ),
      separator(),
    );
  }
  if (site) {
    parts.push(
      item(ICON.muted, rule ? `Always muted (${rule})` : `Always mute ${site}`, () =>
        setMutedSites(rule ? settings.mutedSites.filter((s) => s !== rule) : [site, ...settings.mutedSites]),
      { checked: !!rule }),
    );
  }
  if (saved != null) {
    parts.push(
      item(
        ICON.back,
        'Forget saved volume',
        async () => {
          await saveSiteVolume(site, 1);
          await mediaAction(t.id, 'volume', 1);
        },
        { hint: `${Math.round(saved * 100)}%` },
      ),
    );
  }
  if (site || saved != null) parts.push(separator());
  parts.push(item(ICON.close, 'Close tab', () => chrome.tabs.remove(t.id), { danger: true }));

  ui.menu.replaceChildren(...parts);
  menuTabId = t.id;
  ui.menu.showPopover();

  // Below the ⋯ button, right-aligned; flip above when there's no room.
  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = ui.menu;
  let top = r.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  ui.menu.style.top = `${top}px`;
  ui.menu.style.left = `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px`;
  ui.menu.querySelector('button')?.focus();
}

ui.menu.addEventListener('toggle', (e) => {
  if (e.newState !== 'closed') return;
  menuClosedAt = Date.now();
  // Closed from the keyboard (or by an action): return focus to the row's ⋯ button.
  if (document.activeElement === document.body || ui.menu.contains(document.activeElement)) {
    ui.list.querySelector(`.tab[data-tab-id="${menuTabId}"] [data-act="menu"]`)?.focus();
  }
});

ui.menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...ui.menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next].focus();
});

// ---- Actions ----

// Run an action on a tab, then re-read that tab.
async function runOn(tab, fn, settleMs = 0) {
  await fn();
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  await refreshTab(tab.id);
}

// Click handler for a row button; ignores repeat clicks while the action runs.
// (Not `disabled`, which would drop keyboard focus.)
function act(tab, fn, settleMs = 0) {
  return async (e) => {
    const button = e.currentTarget;
    if (button.dataset.busy) return;
    button.dataset.busy = '1';
    try {
      await runOn(tab, fn, settleMs);
    } finally {
      delete button.dataset.busy;
    }
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

// 100% is the default, so saving it just forgets the site.
async function saveSiteVolume(site, volume) {
  const siteVolumes = { ...settings.siteVolumes };
  if (Math.round(volume * 100) === 100) delete siteVolumes[site];
  else siteVolumes[site] = volume;
  settings.siteVolumes = siteVolumes;
  render();
  await saveSettings({ siteVolumes });
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

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme; // follow the system
  try {
    localStorage.setItem('theme', theme); // read by theme.js before the next first paint
  } catch {}
}

for (const radio of document.querySelectorAll('input[name="theme"]')) {
  radio.addEventListener('change', async () => {
    settings.theme = radio.value;
    applyTheme(settings.theme);
    await saveSettings({ theme: settings.theme });
  });
}

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

// ---- Search & keyboard ----

ui.search.addEventListener('input', () => {
  query = ui.search.value.trim().toLowerCase();
  render();
  $('main').scrollTop = 0;
});

ui.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const [first] = visibleTabs();
    if (first) goTo(first);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    $('.tab .open', ui.list)?.focus();
  } else if (e.key === 'Escape' && ui.search.value) {
    e.preventDefault(); // clear the search instead of closing the popup
    ui.search.value = '';
    ui.search.dispatchEvent(new Event('input'));
  }
});

// ↑/↓ move between rows, Space plays/pauses, M mutes, Enter opens (the row's own button).
ui.list.addEventListener('keydown', (e) => {
  const row = e.target.closest('.tab');
  const tab = row && tabs.find((t) => t.id === Number(row.dataset.tabId));
  if (!tab || e.metaKey || e.ctrlKey || e.altKey) return;
  const onSlider = e.target.type === 'range';

  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !onSlider) {
    e.preventDefault();
    const rows = [...ui.list.querySelectorAll('.tab')];
    const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) $('.open', next).focus();
    else if (e.key === 'ArrowUp') ui.search.focus();
  } else if (e.key === ' ' && e.target.classList.contains('open')) {
    e.preventDefault(); // Space would otherwise "click" the row and switch tabs
    if (hasMedia(tab) && siteOf(tab.url) !== 'meet.google.com') runOn(tab, () => togglePlay(tab.id));
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    runOn(tab, () => setTabMuted(tab.id, !isMuted(tab)));
  }
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
    if (changes.theme) applyTheme(settings.theme);
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
applyTheme(settings.theme);
renderShortcuts();
refresh();
