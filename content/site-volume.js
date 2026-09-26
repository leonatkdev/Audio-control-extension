// Asks the background worker to apply the site's remembered volume whenever new media
// starts playing. Only a new source counts, so resuming after a pause never overrides
// a volume the user changed with the site's own controls.

const applied = new WeakMap(); // media element -> source the volume was applied for

function request() {
  try {
    chrome.runtime.sendMessage({ type: 'media-started' }).catch(() => {});
  } catch {
    // Extension was reloaded; this orphaned script can't reach it anymore.
  }
}

document.addEventListener(
  'play',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement)) return;
    const src = el.currentSrc || el.src || 'stream';
    if (applied.get(el) === src) return;
    applied.set(el, src);
    request();
  },
  true, // 'play' doesn't bubble
);

// A boost above 100% needs a user gesture on the page, so try again after the first one.
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, request, { once: true, capture: true });
}
