// Playback of a granted managed video on a native `<video>` (MY-271), shared by the two places a
// grant plays: the page itself, where `managed-video.js` asked for the grant after the reader
// pressed play (MY-305), and the player page a form opens without JavaScript in the article.
// Renewal goes through the same placement POST (`renew=1`); replacing only the sources keeps the
// native controls, playback position and caption selection on the same element.
//
// An ES module in `static/`, under `script-src 'self'`. It sets no HTML and no style attribute.
// Rejected: a copy of this logic in each place, which drifted once already (the inline frame).

/**
 * Plays `grant` on `video` from `start` seconds. `endpoint` is the placement POST (tracks resolve
 * against it), `Hls` the HLS client where the browser has no native HLS, `unavailable` what to do
 * once the placement no longer grants.
 */
export function play(video, { endpoint, grant, Hls = null, start = 0, resume, unavailable }) {
  let { hls, mp4 } = grant;
  let deadline = Date.now() + grant.lifetime * 1000;
  let useHls = !!(video.canPlayType('application/vnd.apple.mpegurl') || Hls?.isSupported());
  let requestedPlayback = resume;
  let renewing = false;
  let stopped = false;
  let client;
  const at = (src) => new URL(src, new URL(endpoint, location.href)).href;

  function unavailableVideo() {
    stopped = true;
    client?.destroy();
    video.removeAttribute('src');
    video.load();
    unavailable();
  }

  function setSource(position, resume) {
    const previous = client;
    client = undefined;
    previous?.destroy();
    if (useHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const next = new Hls({ enableWorker: false, autoStartLoad: false });
      client = next;
      next.on(Hls.Events.ERROR, (_name, error) => {
        if (client === next && error.fatal) failed();
      });
      next.attachMedia(video);
      next.loadSource(hls);
      if (resume || position > 0) next.startLoad(position);
      else
        video.addEventListener(
          'play',
          () => {
            if (client === next) next.startLoad(video.currentTime);
          },
          { once: true }
        );
    } else {
      video.src = useHls ? hls : mp4;
    }
    if (position > 0) video.currentTime = position;
    if (resume) void video.play().catch(() => {});
  }

  /** The grant's tracks on the element: a signed link per kind, or no element for that kind. */
  function setTracks(next) {
    for (const track of video.querySelectorAll('track')) {
      const src = track.kind === 'chapters' ? next.chapters : next.track;
      if (src) track.src = at(src);
      else track.remove();
    }
  }

  async function renew() {
    if (renewing || stopped) return;
    renewing = true;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ renew: '1' }),
      });
      if (!response.ok) throw new Error();
      const next = await response.json();
      hls = next.hls;
      mp4 = next.mp4;
      deadline = Date.now() + next.lifetime * 1000;
      setTracks(next);
      setSource(video.currentTime, requestedPlayback);
    } catch {
      unavailableVideo();
    } finally {
      renewing = false;
    }
  }

  // Measure the lease against elapsed time, so a viewer's wall clock can differ from the server.
  const expired = () => Date.now() >= deadline;
  function failed() {
    if (stopped || renewing) return;
    if (expired()) void renew();
    else if (useHls) {
      useHls = false;
      setSource(video.currentTime, requestedPlayback);
    } else unavailableVideo();
  }
  video.addEventListener('error', failed);
  video.addEventListener('play', () => {
    requestedPlayback = true;
    if (expired()) void renew();
  });
  video.addEventListener('pause', () => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.error)
      requestedPlayback = false;
  });
  for (const event of ['timeupdate', 'seeking'])
    video.addEventListener(event, () => {
      if (expired() && (requestedPlayback || event === 'seeking')) void renew();
    });
  setSource(start, resume);
}

// The player page: its one video, with the grant in its attributes and the tracks already set.
const page = document.querySelector('video[data-hls]');
if (page)
  play(page, {
    endpoint: location.pathname,
    grant: {
      hls: page.dataset.hls,
      mp4: page.dataset.mp4,
      lifetime: Number(page.dataset.lifetime),
    },
    Hls: window.Hls ?? null,
    start: Number(page.dataset.start) || 0,
    resume: false,
    unavailable() {
      document.getElementById('unavailable').hidden = false;
    },
  });
