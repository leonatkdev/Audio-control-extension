// Helpers shared by the background service worker and the popup.

export const DEFAULT_SETTINGS = {
  mutedSites: [], // hostnames that are always muted
  showAll: true, // popup lists every tab, not only ones with sound/media
};

export function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

export function saveSettings(patch) {
  return chrome.storage.sync.set(patch);
}

// "www.youtube.com/watch?v=…" -> "youtube.com"; null for non-web pages.
export function siteOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// The rule in `sites` that covers `url` (a rule also covers its subdomains).
export function siteRuleFor(url, sites) {
  const host = siteOf(url);
  if (!host) return null;
  return sites.find((s) => host === s || host.endsWith('.' + s)) ?? null;
}

// Pages Chrome lets extensions inject into.
export function canScript(tab) {
  return (
    !tab.discarded &&
    /^(https?|file):/.test(tab.url || '') &&
    !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(tab.url)
  );
}

// ---- Why a tab is muted: 'rule' (always-muted site), or absent when muted by hand. ----
// Kept in session storage so it survives service-worker restarts but not browser restarts.

let lock = Promise.resolve();
function serialized(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

export async function getReasons() {
  const { muteReasons = {} } = await chrome.storage.session.get('muteReasons');
  return muteReasons;
}

export function setTabMuted(tabId, muted, reason = null) {
  return serialized(async () => {
    try {
      await chrome.tabs.update(tabId, { muted });
    } catch {
      return; // tab closed
    }
    const reasons = await getReasons();
    if (muted && reason) reasons[tabId] = reason;
    else delete reasons[tabId];
    await chrome.storage.session.set({ muteReasons: reasons });
  });
}

export function forgetTab(tabId) {
  return serialized(async () => {
    const reasons = await getReasons();
    if (!(tabId in reasons)) return;
    delete reasons[tabId];
    await chrome.storage.session.set({ muteReasons: reasons });
  });
}

// ---- Media elements inside the page ----

// Injected into every frame of a tab, so it must be self-contained.
async function pageMedia(action, value) {
  const found = [];
  const walk = (root) => {
    root.querySelectorAll('video, audio').forEach((el) => found.push(el));
    root.querySelectorAll('*').forEach((el) => el.shadowRoot && walk(el.shadowRoot));
  };
  walk(document);

  const isMeet = location.hostname === 'meet.google.com';
  const isPlaying = (el) => !el.paused && !el.ended;
  // What "play" should resume: something already started, else the biggest video.
  const pick = () =>
    found.find((el) => el.currentTime > 0 && !el.ended) ||
    found
      .filter((el) => el.tagName === 'VIDEO')
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ||
    found[0];

  // Meet's mic/camera toggles carry data-is-muted; tell them apart by their label
  // (or the Ctrl/⌘+D / Ctrl/⌘+E shortcut in it, which survives translation).
  const meetButton = (kind) => {
    if (!isMeet) return null;
    const re = kind === 'mic' ? /microphone|\+\s*d\b/i : /camera|\+\s*e\b/i;
    return (
      [...document.querySelectorAll('[data-is-muted]')].find((b) =>
        re.test(b.getAttribute('aria-label') || ''),
      ) || null
    );
  };

  // Volume above 100% runs the element through a Web Audio gain node. The graph lives
  // on this extension's isolated-world window, so later injections reuse it.
  const boost = (window.__audioControlBoost2 ??= { ctx: null, gains: new WeakMap(), failed: new WeakSet() });
  const gainOf = (el) => boost.gains.get(el)?.target ?? 1;
  // Web Audio outputs silence for cross-origin media without CORS and for WebRTC
  // streams, and can't start on a page the user never interacted with.
  const canBoost = (el) => {
    if (boost.gains.has(el)) return true;
    if (boost.failed.has(el) || el.srcObject || !el.currentSrc) return false;
    if (!navigator.userActivation?.hasBeenActive) return false;
    try {
      const url = new URL(el.currentSrc, location.href);
      return url.origin === location.origin || el.crossOrigin != null;
    } catch {
      return false;
    }
  };
  // Boosted audio passes through a limiter: most music already peaks near full scale,
  // so raw gain would clip into harsh distortion. The limiter only tames the peaks.
  const createLimiter = (ctx) => {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    limiter.connect(ctx.destination);
    return limiter;
  };
  // Send the gain through the limiter only while boosting, so ≤100% stays untouched.
  const route = (gain, boosted) => {
    if (gain.boosted === boosted) return;
    gain.disconnect();
    gain.connect(boosted ? boost.limiter : boost.ctx.destination);
    gain.boosted = boosted;
  };
  const setVolume = async (el, v) => {
    if (v > 1 && !boost.gains.has(el) && canBoost(el)) {
      try {
        boost.ctx ??= new AudioContext();
        boost.limiter ??= createLimiter(boost.ctx);
        const source = boost.ctx.createMediaElementSource(el);
        const gain = boost.ctx.createGain();
        source.connect(gain);
        boost.gains.set(el, gain);
      } catch {
        boost.failed.add(el); // e.g. the page already routes it through its own graph
      }
    }
    const gain = boost.gains.get(el);
    if (gain && boost.ctx.state !== 'running') await boost.ctx.resume().catch(() => {});
    el.volume = Math.min(v, 1);
    if (gain) {
      route(gain, v > 1);
      gain.target = Math.max(v, 1);
      gain.gain.setTargetAtTime(Math.max(v, 1), boost.ctx.currentTime, 0.02); // no zipper clicks
    }
    if (v > 0) el.muted = false;
  };

  switch (action) {
    case 'pause':
      if (!isMeet) found.forEach((el) => el.pause());
      break;
    case 'play':
      if (!isMeet) pick()?.play().catch(() => {});
      break;
    case 'volume':
      for (const el of found) await setVolume(el, value);
      break;
    case 'seek':
      found
        .filter((el) => el.currentTime > 0 && Number.isFinite(el.duration))
        .forEach((el) => (el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + value))));
      break;
    case 'rate':
      found.forEach((el) => (el.playbackRate = value));
      break;
    case 'meet-mic':
    case 'meet-cam':
      meetButton(action === 'meet-mic' ? 'mic' : 'cam')?.click();
      break;
  }

  const meetState = (kind) => {
    const b = meetButton(kind);
    return b ? (b.getAttribute('data-is-muted') === 'true' ? 'off' : 'on') : null;
  };
  const mic = meetState('mic');
  const cam = meetState('cam');
  const main = found.find(isPlaying) || pick();

  return {
    count: found.length,
    playing: found.some(isPlaying),
    resumable: found.some((el) => el.currentTime > 0 && !el.ended),
    volume: found.length ? Math.max(...found.map((el) => el.volume * gainOf(el))) : null,
    boostable: found.some(canBoost),
    rate: main ? main.playbackRate : 1,
    meet: mic || cam ? { mic, cam } : null,
  };
}

async function runInFrames(tabId, action, value = null, frameIds = null) {
  try {
    const results = await chrome.scripting.executeScript({
      target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
      func: pageMedia,
      args: [action, value],
    });
    return results.filter((r) => r.result).map((r) => ({ ...r.result, frameId: r.frameId }));
  } catch {
    return null; // restricted page, closed tab, …
  }
}

function summarize(frames) {
  const withMedia = frames.filter((f) => f.count > 0);
  const main = withMedia.find((f) => f.playing) || withMedia[0];
  return {
    count: withMedia.reduce((n, f) => n + f.count, 0),
    playing: withMedia.some((f) => f.playing),
    volume: withMedia.length ? Math.max(...withMedia.map((f) => f.volume)) : null,
    boostable: withMedia.some((f) => f.boostable),
    rate: main ? main.rate : 1,
    meet: frames.find((f) => f.meet)?.meet ?? null,
  };
}

// action: 'state' | 'pause' | 'volume' (0–3, above 1 boosts) | 'seek' | 'rate' | 'meet-mic' | 'meet-cam'
// Returns the tab's media summary, or null if the page can't be scripted.
export async function mediaAction(tabId, action, value = null) {
  const frames = await runInFrames(tabId, action, value);
  return frames && summarize(frames);
}

// Pause everything if anything plays; otherwise resume media in a single frame,
// so a page with several embeds doesn't start all of them at once.
export async function togglePlay(tabId) {
  const frames = await runInFrames(tabId, 'state');
  if (!frames) return null;
  if (frames.some((f) => f.playing)) return mediaAction(tabId, 'pause');
  const target = frames.find((f) => f.resumable) || frames.find((f) => f.count > 0);
  if (target) await runInFrames(tabId, 'play', null, [target.frameId]);
  return mediaAction(tabId, 'state');
}
