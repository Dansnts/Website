// Home page only (index.html) - the hero terminal, career timeline rail,
// age calculation and FAQ accordion don't exist anywhere else on the
// site, so this doesn't need to be loaded on project or blog pages.
// See main.js for everything shared site-wide (nav, theme, lang, copy
// buttons, scroll reveal).

// ─── Timeline scroll rail ─────────────────────
// Each .timeline gets a rail that fills as you scroll through it, and
// its items light up their dot once scrolled past - both driven off
// the same reference line (35% down the viewport) so the fill height
// and the "passed" dots always agree with each other.
function initTimelineScroll() {
  // Queried once instead of re-querying .timeline-rail-fill/.timeline-item
  // on every scroll frame.
  const timelines = Array.from(document.querySelectorAll('.timeline')).map(el => ({
    el,
    fill: el.querySelector('.timeline-rail-fill'),
    items: Array.from(el.querySelectorAll('.timeline-item')),
  }));
  if (!timelines.length) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const refY = window.innerHeight * 0.35;

    // Read phase: every getBoundingClientRect() first, no style writes
    // in between - interleaving read/write per timeline was forcing a
    // layout recalc on each iteration (layout thrashing).
    for (const t of timelines) {
      if (!t.fill || !t.items.length) continue;
      const rect = t.el.getBoundingClientRect();
      t.progress = Math.min(1, Math.max(0, (refY - rect.top) / rect.height));
      t.passed = t.items.map(item => item.getBoundingClientRect().top <= refY);
    }

    // Write phase.
    for (const t of timelines) {
      if (!t.fill || !t.items.length) continue;
      t.fill.style.height = (t.progress * 100) + '%';
      t.items.forEach((item, i) => item.classList.toggle('is-passed', t.passed[i]));
    }
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

// ─── Skills terminal (reveal-on-scroll) ────────
// Used to type each row out character by character, but that read as
// "still loading" to performance tooling for several seconds after the
// page was actually done (see git history). Rows now appear all at
// once on scroll into view, then the idle CLI prompt with its blinking
// cursor takes over - same terminal feel, without the wait.
function initTerminalType() {
  const terminal = document.querySelector('.terminal');
  const rows = document.querySelectorAll('.terminal .skill-row');
  if (!terminal || !rows.length) return;

  function reveal() {
    rows.forEach(row => row.classList.add('is-revealed'));
    terminal.classList.add('is-done'); // shows the idle prompt + blinking cursor
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);
      reveal();
    });
  }, { threshold: 0.3 });

  observer.observe(terminal);
}

document.addEventListener('DOMContentLoaded', () => {
  initTerminalType();
  initTimelineScroll();
  initAge();
  initAccordion();
});
