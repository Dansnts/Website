// Apply theme immediately to avoid flash
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

// Browsers restore the previous scroll position on reload by default -
// with a sticky nav, that means a refresh can land already "stuck" at
// the top instead of starting at its normal, inset position. Anchor
// links (#contact etc.) still scroll on purpose via initHashScrollFix.
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

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
    // Nav (and a few other elements) have their own color/icon
    // transitions running at different durations than the view
    // transition's crossfade - both firing at once is what made nav
    // look out of sync with the rest of the page. Freeze them for the
    // duration of the fade so only the single uniform crossfade shows.
    html.classList.add('theme-transitioning');
    const transition = document.startViewTransition(apply);
    transition.finished.finally(() => html.classList.remove('theme-transitioning'));
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
    headerEl ? fetch('/includes/header.html', { cache: 'no-store' }) : null,
    footerEl ? fetch('/includes/footer.html', { cache: 'no-store' }) : null
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
  const clearance = nav ? nav.getBoundingClientRect().bottom : 0;
  const top = target.getBoundingClientRect().top + window.scrollY - clearance;
  const y = Math.max(top, 0);
  window.scrollTo({ top: y, behavior });
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
// Project detail pages and blog pages aren't part of the single-page
// scroll spy below (no #home to scroll through) - just mark PROJECTS
// or BLOG active from the URL instead.
function initStaticActiveNav() {
  const path = location.pathname;
  const href = path.startsWith('/projects/') ? '/#projects'
             : path.startsWith('/blog/') ? '/blog/'
             : null;
  if (!href) return;

  const link = document.querySelector(`.nav-links a[href="${href}"]`);
  if (!link) return;
  link.classList.add('active');

  const indicator = document.querySelector('.nav-indicator');
  if (!indicator) return;

  const place = () => {
    indicator.style.transform = `translateX(${link.offsetLeft}px)`;
    indicator.style.width = `${link.offsetWidth}px`;
    indicator.classList.add('is-visible');
  };
  place();
  // Two things can still reflow the nav after this first measurement:
  // the custom font finishing (fallback-font metrics until then), and
  // the FR/EN swap, which is dispatched *after* this runs and can
  // change label widths ("Blog" vs "Blog" is the same, but the other
  // links aren't). On a fresh load fonts.ready is slow enough that the
  // language swap always wins the race by the time it resolves; once
  // the font is cached (e.g. navigating from another page on the
  // site) fonts.ready resolves first instead, so both need to be
  // covered explicitly.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(place);
  }
  window.addEventListener('langChange', place);
  window.addEventListener('resize', place);
}

function initSectionSpy() {
  const sectionIds = ['home', 'projects', 'cv', 'contact'];
  // Only run on root page where the sections exist
  if (!document.getElementById('home')) { initStaticActiveNav(); return; }

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
  // Same fallback-font race as initStaticActiveNav: the very first
  // update() below runs before the Geomini webfont swaps in, so the
  // indicator's initial offsetLeft/width come from fallback-font
  // metrics. Re-measuring after fonts.ready fixes the first paint
  // instead of leaving it wrong until the first scroll event.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(update);
  }
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

// ─── Timeline scroll rail ─────────────────────
// Each .timeline gets a rail that fills as you scroll through it, and
// its items light up their dot once scrolled past - both driven off
// the same reference line (35% down the viewport) so the fill height
// and the "passed" dots always agree with each other.
function initTimelineScroll() {
  const timelines = Array.from(document.querySelectorAll('.timeline'));
  if (!timelines.length) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const refY = window.innerHeight * 0.35;
    timelines.forEach(timeline => {
      const fill = timeline.querySelector('.timeline-rail-fill');
      const items = timeline.querySelectorAll('.timeline-item');
      if (!fill || !items.length) return;
      const rect = timeline.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (refY - rect.top) / rect.height));
      fill.style.height = (progress * 100) + '%';
      items.forEach(item => {
        item.classList.toggle('is-passed', item.getBoundingClientRect().top <= refY);
      });
    });
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ─── Accordion (Q&A) ──────────────────────────
function initAccordion() {
  const items = document.querySelectorAll('.qa-item');
  items.forEach(item => {
    const btn = item.querySelector('.qa-question');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const wasOpen = item.classList.contains('is-open');
      items.forEach(other => {
        other.classList.remove('is-open');
        other.querySelector('.qa-question')?.setAttribute('aria-expanded', false);
      });
      if (!wasOpen) {
        item.classList.add('is-open');
        btn.setAttribute('aria-expanded', true);
      }
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

// ─── Skills terminal (type-on-scroll) ────────
// Reads the current (already-translated) text at the moment each row
// scrolls into view rather than at page load, so a language switch
// before that point doesn't leave it typing out stale text.
function initTerminalType() {
  const terminal = document.querySelector('.terminal');
  const rows = document.querySelectorAll('.terminal .skill-row');
  const section = terminal ? terminal.closest('.section') : null;
  if (!terminal || !rows.length) return;

  // The terminal itself is meant to visibly grow row by row - that's
  // the point. What shouldn't move is everything BELOW it: reserve the
  // section's fully-typed height up front (reveal every row for a
  // moment to measure it, then hide them again) so the terminal grows
  // into space that's already there instead of pushing the rest of the
  // page down as it goes.
  if (section) {
    rows.forEach(row => row.classList.add('is-revealed'));
    terminal.classList.add('is-done'); // also reserve room for the idle cursor line below the rows
    section.style.minHeight = section.getBoundingClientRect().height + 'px';
    terminal.classList.remove('is-done');
    rows.forEach(row => row.classList.remove('is-revealed'));
  }

  // Whole rows (prompt label + value) are CSS-hidden by default so
  // there's no flash of content before JS reveals them one at a time -
  // see .terminal .skill-row in style.css. reduced-motion (or if this
  // never got the chance to run) just reveals everything straight away.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    rows.forEach(row => row.classList.add('is-revealed'));
    if (section) section.style.minHeight = '';
    return;
  }

  const speed = 9; // ms per character

  function typeRow(row) {
    return new Promise(resolve => {
      row.classList.add('is-revealed');
      const el = row.querySelector('.skill-val');
      const text = el.textContent;
      el.textContent = '';
      el.classList.add('is-typing');
      let i = 0;
      (function tick() {
        el.textContent = text.slice(0, i);
        i++;
        if (i <= text.length) {
          setTimeout(tick, speed);
        } else {
          el.classList.remove('is-typing');
          resolve();
        }
      })();
    });
  }

  async function typeAll() {
    for (const row of rows) {
      await typeRow(row);
    }
    // Idle CLI prompt with a blinking cursor once everything's typed.
    terminal.classList.add('is-done');
    if (section) section.style.minHeight = '';
  }

  // One trigger on the whole terminal (not per row) so lines type out
  // one after another instead of all at once.
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);
      typeAll();
    });
  }, { threshold: 0.3 });

  observer.observe(terminal);
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadComponents();
  updateLangButton();
  updatePdfLink();
  window.dispatchEvent(new CustomEvent('langChange', { detail: currentLang }));
  initScrollReveal();
  initNavScroll();
  initTerminalType();
  initTimelineScroll();
  initAge();
  initAccordion();
  initLightbox();
});
