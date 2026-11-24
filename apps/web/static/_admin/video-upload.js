// A file kept by the operator resumes its own pending intent. No video bytes cross Mycel.
const form = document.querySelector('[data-video-upload]');
if (form && window.tus) {
  form.hidden = false;
  const out = form.querySelector('[data-video-status]');
  const button = form.querySelector('button[type=submit]');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function call(operation, body) {
    const response = await fetch(`${form.dataset.endpoint}?operation=${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const problem = await response.json();
      throw new Error(problem.code);
    }
    return response.json();
  }

  async function duration(file) {
    const video = document.createElement('video');
    const source = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        video.preload = 'metadata';
        video.onloadedmetadata = () =>
          Number.isFinite(video.duration) && video.duration > 0
            ? resolve(Math.ceil(video.duration))
            : reject(new Error('duration'));
        video.onerror = () => reject(new Error('duration'));
        video.src = source;
      });
    } finally {
      URL.revokeObjectURL(source);
    }
  }

  async function send(file, grant) {
    return new Promise((resolve, reject) => {
      const upload = new window.tus.Upload(file, {
        endpoint: 'https://video.bunnycdn.com/tusupload',
        headers: {
          AuthorizationSignature: grant.signature,
          AuthorizationExpire: String(grant.expires),
          VideoId: grant.videoId,
          LibraryId: grant.libraryId,
        },
        metadata: { filetype: file.type },
        retryDelays: [0, 1000, 3000, 5000],
        fingerprint: async () => `mycel-video:${grant.libraryId}:${grant.videoId}`,
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => {
          out.textContent = `${form.dataset.working} ${Math.floor((sent / total) * 100)}%`;
        },
        onError: reject,
        onSuccess: resolve,
      });
      upload
        .findPreviousUploads()
        .then((previous) => {
          if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
          upload.start();
        })
        .catch(reject);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    out.textContent = form.dataset.working;
    try {
      const data = new FormData(form);
      const file = data.get('file');
      const fingerprint = `${location.pathname}:${file.name}:${file.size}:${file.lastModified}`;
      let uploadKey = localStorage.getItem(fingerprint);
      if (!uploadKey) {
        uploadKey = crypto.randomUUID();
        localStorage.setItem(fingerprint, uploadKey);
      }
      const title = Object.fromEntries(
        [...data].flatMap(([key, value]) =>
          key.startsWith('title.') && value.trim() ? [[key.slice(6), value]] : []
        )
      );
      let video = await call('create', {
        uploadKey,
        title,
        posterId: data.get('poster'),
        maker: data.get('maker'),
        licence: { code: data.get('licence') },
        watchUrl: data.get('watch') || null,
        sizeBytes: file.size,
        durationSeconds: await duration(file),
      });
      const target = { id: video.id };
      for (let tries = 0; tries < 30 && ['reserved', 'creating'].includes(video.state); tries++) {
        await wait(1000);
        video = await call('check', target);
      }
      if (video.state === 'upload') await send(file, await call('resume', target));
      else if (!['encoding', 'ready'].includes(video.state)) throw new Error(video.state);
      out.textContent = form.dataset.encoding;
      location.reload();
    } catch (err) {
      out.textContent =
        err.message === 'limit_exceeded' ? form.dataset.storage : form.dataset.failed;
    } finally {
      button.disabled = false;
    }
  });
}
