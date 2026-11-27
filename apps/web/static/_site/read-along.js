// A media article's read-along (MY-305; ADR 025, amended 2026-11-27). Without this module the
// header is complete: the poster with its same-site play form, and the transcript as a list with
// a visible start time per line (`MediaStage.svelte`). With it:
//   - each line becomes a button that seeks there and plays; a player that is not loaded yet is
//     started through its own form first (embed.js frames it), then sought once its video exists;
//   - the line that sounds gets `aria-current="true"` and the panel follows it, until the reader
//     scrolls the panel; then "back to now" returns to it. No smooth scrolling under reduced
//     motion, and the page itself never scrolls;
//   - the search marks its hits with the CSS Custom Highlight API (no markup is rewritten), counts
//     them in a status, and Enter and Shift+Enter step through them, Escape clears;
//   - `?t=<seconds>` on the address (also `3:10` or `3m10s`) starts the player there, a same-page
//     link with `?t=` jumps without a reload, and "share from" copies such a link;
//   - captions in the picture, under it or off, on the player's text track, remembered per browser.
// No single-key shortcuts (WCAG 2.1.4) and no live region for the running text.
//
// A plain module in `static/`, from the site's own origin under `script-src 'self'`, after
// embed.js in the document. It sets no HTML and no style attribute (Trusted Types and the CSP
// stay as they are): text through `textContent`, state through attributes the stylesheet reads.
// The player is a same-origin frame (`_video/...`), so its `<video>` is reachable directly; the
// placement and the grant stay the server's. Rejected: a player of our own around the native one
// (the native controls stay) and the provider's player API (a third-party script in the page).

export const CAPTION_MODES = ['showing', 'hidden', 'disabled'];
const STORE = 'mycel.captions';

/** A time on the recording as a reader writes it: `3:10`, `1:02:03`. */
export function clockTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const pair = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return hours ? `${hours}:${pair(minutes)}:${pair(whole % 60)}` : `${minutes}:${pair(whole % 60)}`;
}

/** The moment `t` in a query string names, in seconds, or null: `190`, `190.5`, `3:10`, `3m10s`. */
export function momentOf(search) {
  const value = new URLSearchParams(search).get('t')?.trim();
  if (!value) return null;
  let seconds = null;
  if (/^\d+(?:\.\d+)?$/.test(value)) seconds = Number(value);
  else if (/^\d+(?::[0-5]\d){1,2}$/.test(value))
    seconds = value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  else {
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
    if (parts && (parts[1] || parts[2] || parts[3]))
      seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  }
  return seconds !== null && Number.isFinite(seconds) ? seconds : null;
}

/** The line that sounds at `time`: the last one started, or -1 before the first. */
export function lineAt(starts, time) {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/**
 * Every occurrence of `query` in the lines, ignoring case, as `{ line, start, end }` offsets into
 * that line's text. A query of only spaces finds nothing. Lower case that changes a text's length
 * (rare letters) would shift the offsets, so such a line is searched as it is written.
 */
export function findMatches(texts, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const out = [];
  texts.forEach((text, line) => {
    const lower = text.toLocaleLowerCase();
    const haystack = lower.length === text.length ? lower : text;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1))
      out.push({ line, start: at, end: at + needle.length });
  });
  return out;
}

/** The page's own address at a moment: the path with only `t`, in whole seconds. */
export function shareUrl(href, seconds) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
  return url.href;
}

function storedMode() {
  try {
    const mode = localStorage.getItem(STORE);
    return CAPTION_MODES.includes(mode) ? mode : null;
  } catch {
    return null;
  }
}

function enhance(stage) {
  const form = stage.querySelector('form[data-managed-video]');
  const panel = stage.querySelector('[data-read-along]');
  const list = panel?.querySelector('.read-along-lines') ?? null;
  const lines = list ? [...list.children] : [];
  const starts = lines.map((line) => Number(line.dataset.start));
  const texts = lines.map((line) => line.querySelector('.read-along-text')?.firstChild ?? null);
  const now = panel?.querySelector('[data-read-along-now]') ?? null;
  const controls = stage.querySelector('[data-media-controls]');
  const captionLine = stage.querySelector('[data-caption-line]');
  const radios = [...stage.querySelectorAll('.caption-modes input[type="radio"]')];
  const share = stage.querySelector('[data-share]');
  const shareStatus = stage.querySelector('[data-share-status]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  let video = null;
  let pending = null;
  let connected = false;
  let current = -1;
  let following = true;
  let startAt = momentOf(location.search);
  let mode = storedMode() ?? 'showing';

  // The panel scrolls, never the page: the line's offset in the list (`position: relative`).
  function reveal(line) {
    if (!list || !line) return;
    list.scrollTo({
      top: Math.max(0, line.offsetTop - list.clientHeight / 3),
      behavior: motion.matches ? 'auto' : 'smooth',
    });
  }
  function resume() {
    following = true;
    if (now) now.hidden = true;
  }
  function pause() {
    if (!following) return;
    following = false;
    if (now) now.hidden = current < 0;
  }
  function follow(time) {
    const index = lineAt(starts, time);
    if (index !== current) {
      lines[current]?.removeAttribute('aria-current');
      lines[index]?.setAttribute('aria-current', 'true');
      current = index;
      if (following) reveal(lines[index]);
      else if (now) now.hidden = index < 0;
    }
    if (share) {
      const label = share.dataset.label.replace('{time}', () => clockTime(time));
      if (share.textContent !== label) share.textContent = label;
    }
  }

  function applyCaptions() {
    const track = video?.textTracks[0];
    for (const radio of radios) radio.checked = radio.value === mode;
    if (captionLine) captionLine.hidden = mode !== 'hidden' || !track;
    if (track && track.mode !== mode) track.mode = mode;
    // A cue that is already active fires no change; print it now.
    if (track) showCue(track);
  }
  function showCue(track) {
    if (!captionLine || mode !== 'hidden') return;
    captionLine.textContent = [...(track.activeCues ?? [])]
      .map((cue) => cue.getCueAsHTML?.().textContent ?? cue.text)
      .join('\n');
  }
  const bound = new WeakSet();
  function watchTracks(element) {
    const tracks = element.textTracks;
    const bind = (track) => {
      if (!track || bound.has(track)) return;
      bound.add(track);
      track.addEventListener('cuechange', () => showCue(track));
    };
    for (const track of tracks) bind(track);
    tracks.addEventListener('addtrack', (event) => {
      bind(event.track);
      applyCaptions();
    });
    // The player's own menu can switch the captions too; follow it and remember that choice.
    tracks.addEventListener('change', () => {
      const chosen = tracks[0]?.mode;
      if (!chosen || chosen === mode) return;
      mode = chosen;
      try {
        localStorage.setItem(STORE, mode);
      } catch {}
      applyCaptions();
    });
  }

  function seek(element, time, play) {
    element.currentTime = time;
    // Before its metadata the element keeps the time as its start position; a source the player
    // replaces on a failed stream can lose it, so set it once more when the metadata is there.
    if (element.readyState < 1)
      element.addEventListener(
        'loadedmetadata',
        () => {
          if (Math.abs(element.currentTime - time) > 0.5) element.currentTime = time;
        },
        { once: true }
      );
    if (play) void element.play().catch(() => {});
    follow(time);
  }
  function attach(element) {
    if (video === element) return;
    video = element;
    element.addEventListener('timeupdate', () => follow(element.currentTime));
    element.addEventListener('seeked', () => follow(element.currentTime));
    watchTracks(element);
    applyCaptions();
    if (startAt !== null) {
      seek(element, startAt, false);
      startAt = null;
    }
    const run = pending;
    pending = null;
    run?.(element);
  }
  function connect() {
    if (connected || !form) return;
    // embed.js framed the form in its own submit listener, which runs before this one.
    const frame = form.parentElement?.querySelector('iframe.managed-video-frame');
    if (!frame) return;
    connected = true;
    frame.addEventListener('load', () => {
      const found = frame.contentDocument?.querySelector('video');
      if (found) attach(found);
    });
  }
  form?.addEventListener('submit', connect);
  function withVideo(action) {
    if (video?.isConnected) return action(video);
    pending = action;
    if (form && !connected) form.requestSubmit();
  }
  function jump(time, focusAfter) {
    resume();
    follow(time);
    withVideo((element) => {
      seek(element, time, true);
      // The frame takes the focus when it loads (embed.js); give it back to what the reader used.
      if (focusAfter && document.activeElement?.tagName === 'IFRAME')
        focusAfter.focus({ preventScroll: true });
    });
  }

  // Lines become buttons; the list no longer needs its own tab stop.
  lines.forEach((line, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'read-along-seek';
    button.append(...line.childNodes);
    line.append(button);
    button.addEventListener('click', () => jump(starts[index], button));
  });
  if (list) {
    list.removeAttribute('tabindex');
    for (const type of ['wheel', 'touchmove'])
      list.addEventListener(type, pause, { passive: true });
    // Dragging the scroll bar, and keys that scroll the panel from a focused line.
    list.addEventListener('pointerdown', (event) => {
      if (event.target === list) pause();
    });
    list.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
        pause();
    });
  }
  now?.addEventListener('click', () => {
    resume();
    const line = lines[current];
    reveal(line);
    line?.querySelector('button')?.focus({ preventScroll: true });
  });

  const search = panel?.querySelector('[data-read-along-search]');
  const input = search?.querySelector('input');
  const count = search?.querySelector('[role="status"]');
  const highlights = typeof Highlight === 'function' && !!globalThis.CSS?.highlights;
  let hits = [];
  let hit = -1;
  function paint() {
    if (highlights) {
      const ranges = hits.map(({ line, start, end }) => {
        const range = new Range();
        range.setStart(texts[line], start);
        range.setEnd(texts[line], end);
        return range;
      });
      CSS.highlights.set('read-along-match', new Highlight(...ranges));
      if (hit >= 0) CSS.highlights.set('read-along-hit', new Highlight(ranges[hit]));
      else CSS.highlights.delete('read-along-hit');
    }
    if (count)
      count.textContent = !input.value.trim()
        ? ''
        : hits.length
          ? count.dataset.count
              .replace('{n}', String(hit + 1))
              .replace('{total}', String(hits.length))
          : count.dataset.none;
    if (hit >= 0) {
      pause();
      reveal(lines[hits[hit].line]);
    }
  }
  function step(by) {
    if (!hits.length) return;
    hit = (hit + by + hits.length) % hits.length;
    paint();
  }
  if (search && input) {
    input.addEventListener('input', () => {
      hits = findMatches(
        texts.map((node) => node?.data ?? ''),
        input.value
      ).filter(({ line }) => texts[line]);
      // Start at the first hit from the line that sounds, so a search does not jump back.
      const after = hits.findIndex(({ line }) => line >= Math.max(current, 0));
      hit = hits.length ? Math.max(after, 0) : -1;
      paint();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape' && input.value) {
        event.preventDefault();
        input.value = '';
        hits = [];
        hit = -1;
        paint();
      }
    });
    for (const button of search.querySelectorAll('[data-find]'))
      button.addEventListener('click', () => step(button.dataset.find === 'next' ? 1 : -1));
    search.hidden = false;
  }

  for (const radio of radios)
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      mode = radio.value;
      try {
        localStorage.setItem(STORE, mode);
      } catch {}
      applyCaptions();
    });
  applyCaptions();

  share?.addEventListener('click', async () => {
    const time = video ? video.currentTime : current >= 0 ? starts[current] : (startAt ?? 0);
    const address = shareUrl(location.href, time);
    try {
      await navigator.clipboard.writeText(address);
      shareStatus.textContent = share.dataset.copied;
    } catch {
      // No clipboard (an insecure origin, a refusal): show the address so it can be copied.
      shareStatus.textContent = address;
    }
  });
  if (controls) controls.hidden = false;

  // A same-page link with a moment, in the article's text or anywhere else on the page.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    const time = momentOf(url.search);
    if (time === null) return;
    event.preventDefault();
    history.replaceState(history.state, '', url.href);
    jump(time, link);
  });

  if (startAt !== null) follow(startAt);
}

if (typeof document !== 'undefined')
  for (const stage of document.querySelectorAll('[data-media-stage]')) {
    try {
      enhance(stage);
    } catch (error) {
      // The list and the play form keep working; say why the read-along was not enhanced.
      console.error('read-along not enhanced', error);
    }
  }
