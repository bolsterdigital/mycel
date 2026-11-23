// On the explicit player response only. Keep the native controls on both playback paths.
(() => {
  const video = document.querySelector('video[data-hls]');
  if (!video) return;
  const { hls, mp4 } = video.dataset;
  const unavailable = document.getElementById('unavailable');
  let playingHls = false;
  let requestedPlayback = !video.paused;
  video.addEventListener('play', () => {
    requestedPlayback = true;
  });
  video.addEventListener('pause', () => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.error)
      requestedPlayback = false;
  });
  let client;
  const fallback = () => {
    if (!playingHls) {
      unavailable.hidden = false;
      return;
    }
    playingHls = false;
    const resume = requestedPlayback;
    client?.destroy();
    video.src = mp4;
    if (resume) void video.play().catch(() => {});
  };
  video.addEventListener('error', fallback);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    playingHls = true;
    video.src = hls;
  } else if (window.Hls?.isSupported()) {
    playingHls = true;
    // A blob worker would need its own CSP exception. The main thread demuxes only after play.
    client = new window.Hls({ enableWorker: false, autoStartLoad: false });
    client.on(window.Hls.Events.ERROR, (_name, error) => {
      if (error.fatal) fallback();
    });
    client.attachMedia(video);
    client.loadSource(hls);
    video.addEventListener('play', () => client.startLoad(), { once: true });
  }
})();
