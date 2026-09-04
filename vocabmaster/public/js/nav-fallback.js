// Ensure links to the Creator Portal always navigate even if other handlers intercept
document.addEventListener('DOMContentLoaded', function () {
  try {
    const anchors = Array.from(document.querySelectorAll('a[href$="creator-portal.html"]'));
    anchors.forEach((a) => {
      // prefer same-window navigation
      try { a.target = a.target || '_self'; } catch {}
      // add a resilient click fallback
      a.addEventListener('click', function (ev) {
        // let any other handlers run first; if default was prevented, do nothing
        setTimeout(() => {
          if (ev.defaultPrevented) return;
          const href = a.getAttribute('href');
          if (!href) return;
          // Force navigation as a last resort
          if (window.location.pathname !== href) {
            window.location.href = href;
          }
        }, 10);
      });
    });
  } catch (err) {
    // silent
    console.error('nav-fallback init failed', err);
  }
});
