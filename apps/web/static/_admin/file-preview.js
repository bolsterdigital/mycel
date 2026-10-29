// Progressive enhancement for the shared FileDrop (editor trial 2026-10-28): a chosen image shows as a thumbnail
// before upload. The native file input stays the whole path without this script. Read as data:
// URLs because the CSP allows `img-src 'self' data:`, not blob:.
const MAX = 12;

for (const input of document.querySelectorAll('input[type="file"][data-file-preview]')) {
  const list = document.createElement('ul');
  list.className = 'ui-filedrop-previews';
  list.setAttribute('aria-label', input.dataset.filePreview);
  list.hidden = true;
  input.after(list);
  input.addEventListener('change', () => {
    list.replaceChildren();
    const images = [...(input.files ?? [])].filter((f) => f.type.startsWith('image/'));
    list.hidden = images.length === 0;
    for (const file of images.slice(0, MAX)) {
      const item = document.createElement('li');
      const img = document.createElement('img');
      img.alt = file.name;
      item.append(img);
      list.append(item);
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }
  });
}
