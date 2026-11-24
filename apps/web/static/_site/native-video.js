// Renew through the original placement POST. Replacing only the sources keeps the native
// controls, playback position and caption selection on the same element.
(() => {
  const video = document.querySelector('video[data-hls]');
  if (!video) return;
  const unavailable = document.getElementById('unavailable');
  const restart = document.getElementById('restart');
  let { hls, mp4 } = video.dataset;
  let deadline = Date.now() + Number(video.dataset.lifetime) * 1000;
  let useHls = !!(video.canPlayType('application/vnd.apple.mpegurl') || window.Hls?.isSupported());
  let requestedPlayback = false;
  let renewing = false;
  let stopped = false;
  let client;

  function unavailableVideo() {
    stopped = true;
    client?.destroy();
    video.removeAttribute('src');
    video.load();
    unavailable.hidden = false;
    restart.hidden = false;
  }

  function setSource(position, resume) {
    const previous = client;
    client = undefined;
    previous?.destroy();
    if (useHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const next = new window.Hls({ enableWorker: false, autoStartLoad: false });
      client = next;
      next.on(window.Hls.Events.ERROR, (_name, error) => {
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

  async function renew() {
    if (renewing || stopped) return;
    renewing = true;
    try {
      const response = await fetch(location.pathname, {
        method: 'POST',
        body: new URLSearchParams({ renew: '1' }),
      });
      if (!response.ok) throw new Error();
      const grant = await response.json();
      hls = grant.hls;
      mp4 = grant.mp4;
      deadline = Date.now() + grant.lifetime * 1000;
      const track = video.querySelector('track');
      if (track && grant.track) track.src = grant.track;
      else if (track) track.remove();
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
  setSource(0, false);
})();
