(() => {
  document.querySelectorAll('[data-carousel]').forEach(carousel => {
    const slides = [...carousel.querySelectorAll('[data-slide]')];
    const count = carousel.querySelector('[data-carousel-count]');
    let index = 0;
    const show = next => {
      index = (next + slides.length) % slides.length;
      slides.forEach((slide, position) => { slide.hidden = position !== index; });
      count.textContent = `${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    };
    carousel.querySelector('[data-carousel-prev]').addEventListener('click', () => show(index - 1));
    carousel.querySelector('[data-carousel-next]').addEventListener('click', () => show(index + 1));
    carousel.querySelector('.media-window').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      show(index + (event.key === 'ArrowRight' ? 1 : -1));
    });
    let startX = null;
    carousel.querySelector('.media-window').addEventListener('touchstart', event => {
      startX = event.touches.length === 1 ? event.touches[0].clientX : null;
    }, { passive: true });
    carousel.querySelector('.media-window').addEventListener('touchend', event => {
      if (startX !== null && event.changedTouches.length) {
        const distance = event.changedTouches[0].clientX - startX;
        if (Math.abs(distance) > 55) show(index + (distance < 0 ? 1 : -1));
      }
      startX = null;
    }, { passive: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.lang-btn[aria-expanded="true"],.mobile-toggle[aria-expanded="true"]').forEach(button => {
      button.click();
      button.focus();
    });
  });
})();
