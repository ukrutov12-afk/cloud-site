(() => {
  const themes = ['violet', 'ice', 'acid', 'ember'];
  const root = document.documentElement;
  const apply = value => {
    root.dataset.theme = themes.includes(value) ? value : 'violet';
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === root.dataset.theme));
    });
  };
  let saved;
  try { saved = localStorage.getItem('zephyr.theme'); } catch {}
  apply(saved);
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.addEventListener('click', () => {
        apply(button.dataset.themeChoice);
        try { localStorage.setItem('zephyr.theme', root.dataset.theme); } catch {}
      });
    });
  });
  window.addEventListener('storage', event => {
    if (event.key === 'zephyr.theme') apply(event.newValue);
  });
})();
