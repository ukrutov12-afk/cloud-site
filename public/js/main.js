// мобильное меню
document.querySelector('.burger')?.addEventListener('click', () => {
  document.querySelector('.nav-mobile')?.classList.toggle('open');
});

// выбор языка по клику (для тач-устройств, hover уже работает на десктопе)
const lang = document.querySelector('.lang');
const langBtn = document.querySelector('.lang-btn');
langBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  lang.classList.toggle('open');
  const menu = lang.querySelector('.lang-menu');
  if (menu) {
    const open = lang.classList.contains('open');
    menu.style.opacity = open ? '1' : '';
    menu.style.visibility = open ? 'visible' : '';
    menu.style.transform = open ? 'translateY(0)' : '';
  }
});
document.addEventListener('click', () => {
  if (!lang) return;
  lang.classList.remove('open');
  const menu = lang.querySelector('.lang-menu');
  if (menu) { menu.style.opacity = ''; menu.style.visibility = ''; menu.style.transform = ''; }
});

// ── reveal-on-scroll: плавное появление блоков ──
(function(){
  var sel = '.feature-card, .panel, .cta-band, .price-card, .stat-card, .hero-stats > div, .data-row, .faq, .plan-opt';
  var els = Array.prototype.slice.call(document.querySelectorAll(sel));
  if (!('IntersectionObserver' in window) || !els.length) return;
  // стаггер внутри каждого родителя
  var seen = new Map();
  els.forEach(function(el){
    el.classList.add('anim-init');
    var p = el.parentElement || document.body;
    var n = seen.get(p) || 0; seen.set(p, n + 1);
    el.style.transitionDelay = Math.min(n, 7) * 55 + 'ms';
  });
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){ e.target.classList.add('anim-in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  els.forEach(function(el){ io.observe(el); });
})();

// флеш — мягко скрыть через 4с
const flash = document.querySelector('.flash');
if (flash) setTimeout(() => {
  flash.style.transition = 'opacity .5s, transform .5s';
  flash.style.opacity = '0';
  flash.style.transform = 'translateY(-8px)';
}, 4000);
