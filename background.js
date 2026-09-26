import {
  forgetTab,
  getReasons,
  getSettings,
  mediaAction,
  setTabMuted,
  siteOf,
  siteRuleFor,
  togglePlay,
} from './lib/media.js';

// ---- Badge: how many tabs are audibly playing ----

async function updateBadge() {
  const tabs = await chrome.tabs.query({ audible: true });
  const n = tabs.filter((t) => !t.mutedInfo?.muted).length;
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

// ---- Always-muted sites ----

async function applySiteRule(tab, mutedSites) {
  const reasons = await getReasons();
  if (siteRuleFor(tab.url, mutedSites)) {
    if (reasons[tab.id] !== 'rule') await setTabMuted(tab.id, true, 'rule');
  } else if (reasons[tab.id] === 'rule') {
    // Navigated away from a muted site.
    await setTabMuted(tab.id, false);
  }
}

async function applySiteRulesToAll() {
  const [{ mutedSites }, tabs] = await Promise.all([getSettings(), chrome.tabs.query({})]);
  await Promise.all(tabs.map((t) => applySiteRule(t, mutedSites)));
}

// ---- Remembered site volumes ----

// The content script reports new media starting in a frame; set it to the saved volume.
async function applySiteVolume(tab, frameId) {
  const site = siteOf(tab.url);
  if (!site) return;
  const { siteVolumes } = await getSettings();
  const volume = siteVolumes[site];
  if (volume != null) await mediaAction(tab.id, 'volume', volume, [frameId]);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'media-started' && sender.tab) applySiteVolume(sender.tab, sender.frameId);
});

// ---- Last tab that played sound (target of the play/pause shortcut) ----

async function setLastPlayed(tabId) {
  await chrome.storage.session.set({ lastPlayed: tabId });
}

async function getLastPlayed() {
  const { lastPlayed } = await chrome.storage.session.get('lastPlayed');
  if (lastPlayed == null) return null;
  try {
    return await chrome.tabs.get(lastPlayed);
  } catch {
    return null;
  }
}

// ---- Events ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.remove('focusMode'); // setting from 1.0.0, no longer used
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  updateBadge();
  applySiteRulesToAll();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  updateBadge();
  applySiteRulesToAll();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) applySiteRule(tab, (await getSettings()).mutedSites);
  if (info.audible === true) setLastPlayed(tabId);
  if ('audible' in info || info.mutedInfo) updateBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  updateBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.mutedSites) applySiteRulesToAll();
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const all = await chrome.tabs.query({});

  switch (command) {
    case 'toggle-mute-tab':
      if (tab) await setTabMuted(tab.id, !tab.mutedInfo?.muted);
      break;

    case 'mute-other-tabs':
      await Promise.all(
        all.filter((t) => t.id !== tab?.id && t.audible).map((t) => setTabMuted(t.id, true)),
      );
      break;

    case 'toggle-mute-all': {
      const audible = all.filter((t) => t.audible);
      const anyUnmuted = audible.some((t) => !t.mutedInfo?.muted);
      const targets = anyUnmuted ? audible : all.filter((t) => t.mutedInfo?.muted);
      await Promise.all(targets.map((t) => setTabMuted(t.id, anyUnmuted)));
      break;
    }

    case 'toggle-play': {
      const target = (await getLastPlayed()) ?? tab;
      if (!target) break;
      const state = await mediaAction(target.id, 'state');
      // Fall back to the current tab if the remembered one has no media anymore.
      await togglePlay(state?.count || !tab ? target.id : tab.id);
      break;
    }
  }
});
