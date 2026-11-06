// One file to the media upload route (`media/upload`), for every script that uploads: the media
// picker, the library's window-wide drop and the edit screen's drop and paste. XHR, because
// fetch has no upload progress. Resolves with `{ choice }` (the route's 201 JSON) or `{ error }`
// (the refusal in the operator's words, or '' when there was no answer to read), never rejects.
// Rejected: a copy per script, which had already drifted (one had a timeout, one did not).
export function send(url, file, onProgress = () => {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 120000;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A login page after an expired session, or a proxy error: no JSON.
      }
      resolve(xhr.status === 201 && body?.id ? { choice: body } : { error: body?.error ?? '' });
    });
    for (const event of ['error', 'timeout', 'abort'])
      xhr.addEventListener(event, () => resolve({ error: '' }));
    const data = new FormData();
    data.append('file', file);
    xhr.send(data);
  });
}

/** An upload the edit screen can place as an image: not a document and not a sound file. */
export const isImage = (choice) => !!choice && !choice.document && !choice.audio;

/**
 * One file's line in an upload list: its words and a progress bar the caller fills, so every
 * drop shows its progress the same way. The bar is named by the words it starts with.
 */
export function progressRow(text) {
  const row = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = text;
  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 0;
  bar.setAttribute('aria-label', text);
  row.append(label, bar);
  return { row, label, bar };
}
