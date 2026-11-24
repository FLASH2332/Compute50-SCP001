// Recording overlay (A1.9), injected with addInitScript on every page of a take.
// Draws a fake cursor, a highlight ring, a click ripple and a step badge.
// Nothing here is clickable (pointer-events: none).
(() => {
  if (window.__demo) return;
  let root;
  const ensure = () => {
    if (root && root.isConnected) return root;
    const host = document.createElement('div');
    host.id = '__demo_overlay';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-3px,-2px);transition:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
      .ring{position:fixed;border:3px solid #ffcc00;border-radius:10px;box-shadow:0 0 0 4px rgba(255,204,0,.25),0 0 18px rgba(255,204,0,.55);opacity:0;transition:opacity .2s, left .25s, top .25s, width .25s, height .25s}
      .ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ffcc00;animation:rip .5s ease-out forwards}
      @keyframes rip{from{transform:scale(.5);opacity:1}to{transform:scale(3.2);opacity:0}}
      .badge{position:fixed;left:16px;top:16px;padding:6px 12px;border-radius:999px;background:rgba(15,23,42,.85);color:#fff;font:600 14px system-ui,sans-serif;opacity:0;transition:opacity .2s}
    </style>
    <div class="ring"></div><div class="badge"></div>
    <svg class="cursor" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.3"/></svg>`;
    (document.body || document.documentElement).appendChild(host);
    const p = JSON.parse(sessionStorage.getItem('__demo_cursor') || '{"x":640,"y":360}');
    place(p.x, p.y);
    return root;
  };
  let pos = { x: 640, y: 360 };
  const place = (x, y) => {
    pos = { x, y };
    root.querySelector('.cursor').style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    sessionStorage.setItem('__demo_cursor', JSON.stringify(pos));
  };
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  window.__demo = {
    // Eased curved move; duration scales with distance (300–600 ms)
    cursorTo(x, y, ms) {
      ensure();
      const from = { ...pos };
      const dist = Math.hypot(x - from.x, y - from.y);
      const dur = ms || Math.max(300, Math.min(600, 250 + dist * 0.5));
      // control point: off the straight line for a natural arc
      const cx = (from.x + x) / 2 - (y - from.y) * 0.15, cy = (from.y + y) / 2 + (x - from.x) * 0.15;
      return new Promise(resolve => {
        const t0 = performance.now();
        const tick = now => {
          const t = Math.min(1, (now - t0) / dur), e = ease(t);
          const bx = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
          const by = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
          place(bx, by);
          t < 1 ? requestAnimationFrame(tick) : resolve(true);
        };
        requestAnimationFrame(tick);
      });
    },
    highlight(b) {
      const r = ensure().querySelector('.ring');
      const pad = 6;
      Object.assign(r.style, { left: b.x - pad + 'px', top: b.y - pad + 'px', width: b.width + pad * 2 + 'px', height: b.height + pad * 2 + 'px', opacity: '1' });
    },
    clear() { ensure().querySelector('.ring').style.opacity = '0'; },
    ripple(x, y) {
      const d = document.createElement('div');
      d.className = 'ripple';
      d.style.left = x + 'px'; d.style.top = y + 'px';
      ensure().appendChild(d);
      setTimeout(() => d.remove(), 600);
    },
    badge(text) {
      const b = ensure().querySelector('.badge');
      b.textContent = text || '';
      b.style.opacity = text ? '1' : '0';
    },
    busy() {
      const el = document.querySelector('[aria-busy="true"], .spinner, .loading, [role="progressbar"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
  };
})();
