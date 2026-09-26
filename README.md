# Audio Control

A Chrome extension (Manifest V3) for controlling sound across all your tabs: YouTube, Spotify, Google Meet, noisy news sites and background tabs that ping with notification sounds.

## Features

- **See all your tabs** — playing tabs first (switch off *Show all tabs* to list only tabs with sound or media), with a live badge count on the toolbar icon.
- **Per tab:** mute / unmute, play / pause, skip ±10 s, volume slider with boost up to 300%, playback speed (1× → 1.25× → 1.5× → 2× → 0.75×), click the title to jump to the tab.
- **Search:** filter tabs by title or URL; Enter jumps to the first match.
- **Google Meet:** toggle your mic and camera from the popup without switching tabs.
- **Mute all / Unmute all:** one button in the header that shows whichever makes sense right now.
- **Always-muted sites:** mute a site in every tab, now and on future visits (subdomains included). Rules sync across your Chrome profile.
- **Keyboard shortcuts** (change them at `chrome://extensions/shortcuts`):

  | Shortcut | Action |
  | --- | --- |
  | `Alt+Shift+M` | Mute / unmute current tab |
  | `Alt+Shift+P` | Play / pause the last tab that played sound |
  | `Alt+Shift+O` | Mute all other tabs |
  | `Alt+Shift+A` | Mute / unmute all tabs with sound |

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin **Audio Control** from the puzzle-piece menu.

After editing the code, press the reload icon on the extension's card. Works the same in Edge, Brave and other Chromium browsers.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, popup, shortcuts |
| `background.js` | Service worker: badge, always-muted sites, shortcuts |
| `lib/media.js` | Shared helpers, including the function injected into pages to find and control `<video>`/`<audio>` elements (all frames and open shadow roots) |
| `popup/` | The popup UI |

- **Mute** uses Chrome's own tab muting (`chrome.tabs.update({ muted })`), so it silences everything a tab plays, including Web Audio and sounds not attached to the page.
- **Play/pause, volume, seek and speed** run a small script in the page via `chrome.scripting`, which is why the extension needs access to all sites.

## Limitations

- Play/pause and volume only reach media elements in the page. Sounds made with Web Audio or `new Audio()` without being added to the page can only be muted, not paused.
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.
- Volume boost needs the page to allow Web Audio on its media. It isn't offered for media from another domain without CORS, WebRTC calls (e.g. Meet), or a page you haven't clicked on yet — the slider stops at 100% there.
- Pages can reset the volume the extension sets (e.g. YouTube when the next video starts).
- Meet mic/camera buttons are found by their labels, so a Meet redesign may break them; muting the tab still works.
