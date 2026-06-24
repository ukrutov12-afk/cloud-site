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

// флеш — мягко скрыть через 4с
const flash = document.querySelector('.flash');
if (flash) setTimeout(() => {
  flash.style.transition = 'opacity .5s, transform .5s';
  flash.style.opacity = '0';
  flash.style.transform = 'translateY(-8px)';
}, 4000);
