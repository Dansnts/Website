// Project pages with figures only (.project-figure) - not every project
// page has one, so this only gets included where it's actually used.
// See main.js for everything shared site-wide.

// ─── Lightbox (project figures) ──────────────
function initLightbox() {
  const images = document.querySelectorAll('.project-figure img');
  if (!images.length) return;

  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <button class="lightbox-close" aria-label="Fermer" data-tooltip="Fermer">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg>
    </button>
    <figure class="lightbox-figure">
      <img alt="">
      <figcaption class="lightbox-caption"></figcaption>
    </figure>`;
  document.body.appendChild(overlay);

  const imgEl = overlay.querySelector('img');
  const captionEl = overlay.querySelector('.lightbox-caption');
  const closeBtn = overlay.querySelector('.lightbox-close');

  function openLightbox(src, alt, caption) {
    imgEl.src = src;
    imgEl.alt = alt || '';
    captionEl.textContent = caption || '';
    captionEl.style.display = caption ? '' : 'none';
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  images.forEach(img => {
    img.addEventListener('click', () => {
      const caption = img.closest('figure')?.querySelector('figcaption');
      openLightbox(img.src, img.alt, caption ? caption.textContent.trim() : '');
    });
  });

  closeBtn.addEventListener('click', closeLightbox);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
}

document.addEventListener('DOMContentLoaded', initLightbox);
