// Apply theme immediately to avoid flash
(function() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
})();

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
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
  }

  if (footerEl && footerRes) {
    footerEl.outerHTML = await footerRes.text();
  }
}

// ─── Section spy (single-page nav) ───────────
function initSectionSpy() {
  const sectionIds = ['home', 'projects', 'cv'];
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
    navLinks.forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === '/#' + current);
    });
  };

  window.addEventListener('scroll', update, { passive: true });
  update();
}

// ─── Scroll Reveal ───────────────────────────
function initScrollReveal() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
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
});
