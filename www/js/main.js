// Apply theme immediately to avoid flash
(function() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
})();

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  const apply = () => {
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  };
  // Crossfades the whole page between the two theme snapshots instead of
  // an instant snap. No-op (instant apply) on browsers without support.
  if (document.startViewTransition) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

function exportPdf() {
  window.print();
}

// Language
let currentLang = localStorage.getItem('site-lang') || 'fr';

function updateLangButton() {
  const toggle = document.querySelector('.lang-toggle');
  if (!toggle) return;
  toggle.setAttribute('data-lang', currentLang);
  const fr = toggle.querySelector('.lang-fr');
  const en = toggle.querySelector('.lang-en');
  if (fr) fr.classList.toggle('active', currentLang === 'fr');
  if (en) en.classList.toggle('active', currentLang === 'en');
}

function updatePdfLink() {
  const btn = document.getElementById('cv-download-btn');
  if (!btn) return;
  btn.href = currentLang === 'en' ? '/cv-en.pdf' : '/cv-fr.pdf';
  btn.download = currentLang === 'en'
    ? 'CV_Dani_Faria_dos_Santos_EN.pdf'
    : 'CV_Dani_Faria_dos_Santos_FR.pdf';
}

function toggleLanguage() {
  currentLang = currentLang === 'fr' ? 'en' : 'fr';
  localStorage.setItem('site-lang', currentLang);
  updateLangButton();
  updatePdfLink();
  window.dispatchEvent(new CustomEvent('langChange', { detail: currentLang }));
}

// ─── Mobile nav ──────────────────────────
function toggleMobileNav() {
  const nav = document.querySelector('nav');
  if (!nav) return;
  const open = nav.classList.toggle('nav-open');
  document.body.classList.toggle('nav-open', open);
  nav.querySelector('.nav-hamburger')?.setAttribute('aria-expanded', open);
}

function initMobileNav() {
  document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelector('nav')?.classList.remove('nav-open');
      document.body.classList.remove('nav-open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelector('nav')?.classList.remove('nav-open');
      document.body.classList.remove('nav-open');
    }
  });
}


// Load shared header and footer
async function loadComponents() {
  const headerEl = document.getElementById('site-header');
  const footerEl = document.getElementById('site-footer');

  const [headerRes, footerRes] = await Promise.all([
    headerEl ? fetch('/includes/header.html') : null,
    footerEl ? fetch('/includes/footer.html') : null
  ]);

  if (headerEl && headerRes) {
    headerEl.outerHTML = await headerRes.text();
    initSectionSpy();
    initMobileNav();
    initHashScrollFix();
  }

  if (footerEl && footerRes) {
    footerEl.outerHTML = await footerRes.text();
  }
}

// ─── Anchor scroll clearance ──────────────
// scroll-margin-top alone was unreliable once nav became a fixed,
// inset floating bar (its real screen position isn't just "nav's own
// height" anymore). Measure nav's actual bottom edge at scroll time
// instead of guessing a fixed offset in CSS.
function scrollToHash(hash, behavior) {
  const target = document.querySelector(hash);
  if (!target) return;
  const nav = document.querySelector('nav');
  const clearance = nav ? nav.getBoundingClientRect().bottom + 24 : 0;
  const top = target.getBoundingClientRect().top + window.scrollY - clearance;
  window.scrollTo({ top: Math.max(top, 0), behavior });
}

function initHashScrollFix() {
  // Landed here with a hash already in the URL (e.g. clicked "FAQ" from
  // another page). Correct it once nav exists, then again after full
  // load in case web fonts reflowed the layout in between.
  if (location.hash) {
    scrollToHash(location.hash, 'auto');
    window.addEventListener('load', () => scrollToHash(location.hash, 'auto'), { once: true });
  }
  // Same-page nav clicks: take over from the browser's native jump so
  // both cases go through the same, correctly-measured offset.
  document.querySelectorAll('a[href^="/#"], a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const hash = link.getAttribute('href').split('#')[1];
      if (!hash || !document.getElementById(hash)) return;
      e.preventDefault();
      history.pushState(null, '', '#' + hash);
      scrollToHash('#' + hash, 'smooth');
    });
  });
}

// ─── Section spy (single-page nav) ───────────
function initSectionSpy() {
  const sectionIds = ['home', 'projects', 'cv', 'qa'];
  // Only run on root page where the sections exist
  if (!document.getElementById('home')) return;

  const update = () => {
    const navLinks = document.querySelectorAll('.nav-links a[href^="/#"]');
    if (!navLinks.length) return;
    const scrollY = window.scrollY + 120;
    let current = sectionIds[0];
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el && el.offsetTop <= scrollY) current = id;
    }
    let activeLink = null;
    navLinks.forEach(link => {
      const isActive = link.getAttribute('href') === '/#' + current;
      link.classList.toggle('active', isActive);
      if (isActive) activeLink = link;
    });

    const indicator = document.querySelector('.nav-indicator');
    if (indicator && activeLink) {
      indicator.style.transform = `translateX(${activeLink.offsetLeft}px)`;
      indicator.style.width = `${activeLink.offsetWidth}px`;
      indicator.classList.add('is-visible');
    }
  };

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  // FR/EN swaps link text (e.g. "Accueil" <-> "Home"), which changes
  // each link's width - the indicator needs to re-measure or it's left
  // sized for the old word. i18n.js's own 'langChange' listener runs
  // first (registered before this one), so the text is already
  // swapped by the time update() reads offsetWidth here.
  window.addEventListener('langChange', update);
  update();
}

// ─── Scroll Reveal ───────────────────────────
function initScrollReveal() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      entry.target.classList.toggle('in-view', entry.isIntersecting);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('[data-anim]').forEach(el => observer.observe(el));
}

// ─── Nav scroll glassmorphism ────────────────
function initNavScroll() {
  const update = () => {
    const nav = document.querySelector('nav');
    if (nav) nav.classList.toggle('nav-scrolled', window.scrollY > 60);
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// ─── Accordion (Q&A) ──────────────────────────
function initAccordion() {
  document.querySelectorAll('.qa-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.qa-item');
      const open = item.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open);
    });
  });
}

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

// ─── Age (born 2000-04-30) ────────────────────
function initAge() {
  const el = document.getElementById('cv-age');
  if (!el) return;
  const birth = new Date(2000, 3, 30); // month is 0-indexed
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now < new Date(now.getFullYear(), birth.getMonth(), birth.getDate())) age--;
  el.textContent = age;
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadComponents();
  updateLangButton();
  updatePdfLink();
  window.dispatchEvent(new CustomEvent('langChange', { detail: currentLang }));
  initScrollReveal();
  initNavScroll();
  initAge();
  initAccordion();
  initLightbox();
});
