// A managed video plays in the page itself once the reader presses play (MY-271, MY-305). The
// server rendered a poster and a same-site POST form (`ManagedVideo.svelte`); without JavaScript
// that form opens the player page. With it, the press puts a `<video>` in the form's place and
// calls `play()` on it before anything is awaited: that call is what lets a browser start the
// recording with sound, Safari included, which refuses a `play()` made after the press is over.
// Only then is the grant asked for (`renew=1`, JSON) and its sources and signed tracks set.
// Nothing reaches the provider before the press; the page's CSP names the binding's one CDN
// origin for media (integrations.ts). When the video is ready the form gets a `managed-video`
// event with the element as its detail, which `read-along.js` waits for.
//
// An ES module in `static/`, under `script-src 'self'`. It sets no HTML and no style attribute:
// text through `textContent`, the HLS client through `import()` from this origin. Rejected: the
// player page in a frame (the press ended before the frame loaded, so Safari wanted a second one)
// and a frame loaded before the press (a document per video on every page view).
import { play } from './native-video.js';

const captionsOn = (video) =>
  [...video.textTracks].find((track) => track.kind === 'captions' || track.kind === 'subtitles');

/** A signed track of the grant; its link is relative to the placement POST. */
function trackOf(kind, form, src) {
  const track = document.createElement('track');
  track.kind = kind;
  track.src = new URL(src, form.action).href;
  track.srclang = form.dataset.lang;
  if (kind === 'captions') track.label = form.dataset.captions;
  return track;
}

function unavailable(form, video) {
  video.remove();
  form.hidden = false;
  const player = form.closest('.video-player');
  let note = player?.parentElement?.querySelector('.managed-video-unavailable');
  if (!note && player) {
    note = document.createElement('p');
    note.className = 'managed-video-unavailable';
    note.setAttribute('role', 'status');
    player.after(note);
  }
  if (note) note.textContent = form.dataset.unavailable;
}

async function start(form, video) {
  const endpoint = form.action;
  let grant = null;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ renew: '1' }),
    });
    if (response.ok) grant = await response.json();
  } catch {}
  if (!grant) return unavailable(form, video);
  if (grant.track) video.append(trackOf('captions', form, grant.track));
  if (grant.chapters) video.append(trackOf('chapters', form, grant.chapters));
  // Captions on by default for a video in an ordinary page; a media article's stage shows its
  // transcript beside the player and leaves them off (read-along.js decides there).
  const captions = captionsOn(video);
  if (captions && !form.closest('[data-media-stage]')) captions.mode = 'showing';
  // Only a browser without native HLS but with Media Source loads the client, on the press.
  const needsClient =
    !video.canPlayType('application/vnd.apple.mpegurl') &&
    typeof MediaSource === 'function' &&
    grant.client;
  const Hls = needsClient ? (await import(grant.client).catch(() => null))?.default : null;
  play(video, {
    endpoint,
    grant,
    Hls: Hls ?? null,
    start: Number(form.elements.namedItem('t')?.value) || 0,
    resume: true,
    unavailable: () => unavailable(form, video),
  });
  form.dispatchEvent(new CustomEvent('managed-video', { detail: video }));
}

for (const form of document.querySelectorAll('form[data-managed-video]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (form.hidden) return;
    const video = document.createElement('video');
    video.className = 'managed-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'none';
    video.crossOrigin = 'anonymous';
    video.setAttribute('aria-label', form.dataset.title);
    const player = form.closest('.video-player');
    player?.parentElement?.querySelector('.managed-video-unavailable')?.remove();
    form.after(video);
    form.hidden = true;
    video.focus();
    // The press, claimed for this element: no source yet, so the promise settles later or not.
    void video.play()?.catch(() => {});
    void start(form, video);
  });
}
