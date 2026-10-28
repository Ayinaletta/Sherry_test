// Shared UI glue: icon helper, tab bar, theme-color. Loaded synchronously in <head>.
(function () {
  const SPRITE = '/static/icons.svg';
  // ic('house') -> inline <svg><use/></svg>; class goes on the svg (e.g. 'lg', 'spin')
  window.ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
  // swap the icon inside an element (state changes like bell -> bell-off)
  window.setIc = (el, name, cls) => { if (el) el.innerHTML = window.ic(name, cls); };

  const TABS = [
    ['home', '/', 'house', '首页'],
    ['chat', '/chat.html', 'message-circle', '对话'],
    ['reading', '/reading', 'book-open', '共读'],
    ['moments', '/posts', 'aperture', '朋友圈'],
    ['growth', '/growth/', 'sprout', '生长'],
  ];

  function ready() {
    document.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = window.ic(el.dataset.ic, el.dataset.icClass); });
    const nav = document.querySelector('nav.tabbar');
    if (nav) {
      const active = nav.dataset.active;
      nav.innerHTML = TABS.map(([id, href, icon, label]) =>
        `<a class="tab${id === active ? ' active' : ''}" href="${href}" data-tab="${id}">
           <span class="tab-ic">${window.ic(icon)}</span><span class="tab-label">${label}</span><i class="tab-badge"></i>
         </a>`).join('');
    } else if (!document.querySelector('.bottom-nav')) {
      document.body.classList.add('no-tabbar');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();

  // browser chrome follows the palette
  const head = document.head;
  [['(prefers-color-scheme: light)', '#F5F1EA'], ['(prefers-color-scheme: dark)', '#161310']].forEach(([media, color]) => {
    const m = document.createElement('meta'); m.name = 'theme-color'; m.content = color; m.media = media; head.appendChild(m);
  });
})();
