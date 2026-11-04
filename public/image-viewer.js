(() => {
  'use strict';
  let dialog, image, stage, label, sizeButton, download, original = false;
  function fit() {
    if (!dialog?.open) return;
    image.style.maxWidth = original ? 'none' : `${Math.max(1, stage.clientWidth - 32)}px`;
    image.style.maxHeight = original ? 'none' : `${Math.max(1, stage.clientHeight - 32)}px`;
    sizeButton.textContent = original ? '适应窗口' : '原图大小';
    sizeButton.setAttribute('aria-pressed', String(original));
  }
  function create() {
    dialog = document.createElement('dialog'); dialog.className = 'image-viewer';
    dialog.setAttribute('aria-label', '图片预览');
    const header = document.createElement('div'); header.className = 'image-viewer-header';
    label = document.createElement('span'); label.className = 'image-viewer-title';
    const tools = document.createElement('div'); tools.className = 'image-viewer-tools';
    sizeButton = document.createElement('button'); sizeButton.type = 'button';
    sizeButton.onclick = () => { original = !original; fit(); stage.scrollTo(0, 0); };
    download = document.createElement('a'); download.textContent = '下载';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
    close.className = 'image-viewer-close'; close.setAttribute('aria-label', '关闭图片预览'); close.autofocus = true;
    close.onclick = () => dialog.close(); tools.append(sizeButton, download, close); header.append(label, tools);
    stage = document.createElement('div'); stage.className = 'image-viewer-stage';
    const canvas = document.createElement('div'); canvas.className = 'image-viewer-canvas';
    image = document.createElement('img'); image.className = 'image-viewer-image'; image.onload = fit;
    image.onerror = () => { label.textContent = '图片无法读取，请重新上传原文件'; };
    canvas.appendChild(image); stage.appendChild(canvas); dialog.append(header, stage); document.body.appendChild(dialog);
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener('close', () => { image.removeAttribute('src'); download.removeAttribute('href'); });
    window.addEventListener('resize', fit);
  }
  function open(source, name) {
    // Only local raster attachments; no HTML, SVG or external navigation.
    if (!/^data:image\/(png|jpeg);base64,/.test(source)) return;
    if (!dialog) create();
    original = false; label.textContent = name || '会话图片'; image.alt = label.textContent;
    download.href = source; download.download = /\.(png|jpe?g)$/i.test(name || '') ? name : `会话图片.${source.startsWith('data:image/png') ? 'png' : 'jpg'}`;
    if (!dialog.open) dialog.showModal();
    image.src = source; fit(); stage.scrollTo(0, 0);
  }
  function bind(thumbnail) {
    thumbnail.classList.add('image-preview-trigger'); thumbnail.tabIndex = 0;
    thumbnail.setAttribute('role', 'button'); thumbnail.setAttribute('aria-label', `查看大图：${thumbnail.alt || '会话图片'}`);
    thumbnail.title = '点击查看大图';
    thumbnail.addEventListener('click', () => open(thumbnail.src, thumbnail.alt));
    thumbnail.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(thumbnail.src, thumbnail.alt); }
    });
  }
  window.DiagramImageViewer = { bind };
})();
