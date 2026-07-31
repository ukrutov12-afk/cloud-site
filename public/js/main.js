(() => {
  const mobileToggle = document.querySelector('.mobile-toggle');
  const mobileNav = document.querySelector('.mobile-nav');

  function closeMobileNav() {
    if (!mobileToggle || !mobileNav) return;
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileNav.classList.remove('open');
  }

  mobileToggle?.addEventListener('click', () => {
    const nextOpen = mobileToggle.getAttribute('aria-expanded') !== 'true';
    mobileToggle.setAttribute('aria-expanded', String(nextOpen));
    mobileNav?.classList.toggle('open', nextOpen);
  });
  mobileNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMobileNav));

  const lang = document.querySelector('.lang');
  const langButton = lang?.querySelector('.lang-btn');
  langButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextOpen = !lang.classList.contains('open');
    lang.classList.toggle('open', nextOpen);
    langButton.setAttribute('aria-expanded', String(nextOpen));
  });
  document.addEventListener('click', () => {
    lang?.classList.remove('open');
    langButton?.setAttribute('aria-expanded', 'false');
  });

  document.querySelectorAll('.faq-list, .support-faq-list').forEach((list, listIndex) => {
    const items = Array.from(list.querySelectorAll('.faq-item'));
    items.forEach((item, itemIndex) => {
      const button = item.querySelector('.faq-question');
      const answer = item.querySelector('.faq-answer');
      if (!button || !answer) return;

      const triggerId = `faq-${listIndex}-${itemIndex}-trigger`;
      const panelId = `faq-${listIndex}-${itemIndex}-panel`;
      button.id = triggerId;
      button.setAttribute('aria-controls', panelId);
      answer.id = panelId;
      answer.setAttribute('role', 'region');
      answer.setAttribute('aria-labelledby', triggerId);

      button.addEventListener('click', () => {
        const shouldOpen = !item.classList.contains('is-open');
        items.forEach((other) => {
          other.classList.remove('is-open');
          other.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
          other.querySelector('.faq-answer')?.setAttribute('aria-hidden', 'true');
        });
        if (shouldOpen) {
          item.classList.add('is-open');
          button.setAttribute('aria-expanded', 'true');
          answer.setAttribute('aria-hidden', 'false');
        }
      });
    });
  });

  const revealItems = document.querySelectorAll('.reveal-on-scroll');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px' });
    revealItems.forEach((item, index) => {
      item.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
      observer.observe(item);
    });
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  document.querySelectorAll('[data-loading-form]').forEach((form) => {
    form.addEventListener('submit', () => {
      const button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.classList.add('is-loading');
      button.disabled = true;
      button.textContent = 'Zephyr ···';
    });
  });

  document.querySelectorAll('.copy-contact').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(value);
        const label = button.querySelector('b');
        if (!label) return;
        const previous = label.textContent;
        label.textContent = 'Copied';
        window.setTimeout(() => { label.textContent = previous; }, 1400);
      } catch (_) {}
    });
  });

  const flash = document.querySelector('.flash');
  if (flash) window.setTimeout(() => {
    flash.style.transition = 'opacity .45s ease, transform .45s ease';
    flash.style.opacity = '0';
    flash.style.transform = 'translate(-50%, -8px)';
  }, 4200);
})();
