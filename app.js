(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    deg: $('deg'), dir: $('dir'), live: $('live'),
    card: $('card'), ticks: $('ticks'), labels: $('labels'), target: $('target'), bubble: $('bubble'),
    offset: $('offset'), hint: $('hint'), mark: $('mark'), clear: $('clear'),
    start: $('start'), retry: $('retry'), errMsg: $('err-msg'), theme: $('theme'),
  };

  const SVG = 'http://www.w3.org/2000/svg';
  const RAD = Math.PI / 180;
  const DIRS = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut'];
  // Low-pass factor per sensor sample. Sensors fire ~60x/s, so this settles in well under a second.
  const SMOOTH = 0.2;
  const SENSOR_TIMEOUT = 3500;

  const ERRORS = {
    insecure: 'Sensor kompas cuma bisa dipakai lewat HTTPS. Buka halaman ini dari link vercel.app-nya, bukan dari file di komputer.',
    denied: 'Izin sensor arah ditolak. Muat ulang halaman, tekan "Nyalakan kompas", lalu pilih Izinkan.',
    nosensor: 'Perangkat atau browser ini nggak ngirim data kompas. Biasanya ini terjadi di laptop atau PC. Buka di HP pakai Chrome atau Safari.',
    relative: 'Browser ini cuma ngasih arah relatif, bukan arah utara. Coba buka pakai Chrome (Android) atau Safari (iPhone).',
  };

  const norm = (d) => ((d % 360) + 360) % 360;
  const signedDiff = (to, from) => ((to - from + 540) % 360) - 180;

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    parent.appendChild(node);
    return node;
  }

  // ---- Dial ----
  for (let a = 0; a < 360; a += 2) {
    const major = a % 30 === 0;
    const mid = a % 10 === 0;
    if (a === 0) continue; // north gets the red wedge instead
    const len = major ? 20 : mid ? 13 : 7;
    el('line', {
      x1: 0, y1: -186, x2: 0, y2: -186 + len,
      transform: `rotate(${a})`,
      class: major ? 'tick major' : mid ? 'tick mid' : 'tick',
    }, ui.ticks);
  }

  const labels = [];
  const CARDINALS = { 0: 'U', 90: 'T', 180: 'S', 270: 'B' };
  for (let a = 0; a < 360; a += 30) {
    const cardinal = CARDINALS[a];
    const node = el('text', { class: cardinal ? (a === 0 ? 'cardinal north' : 'cardinal') : 'num' }, ui.labels);
    node.textContent = cardinal || String(a);
    labels.push({ a, r: cardinal ? 118 : 146, node });
  }

  // ---- State ----
  let state = 'idle';
  let sx = 0, sy = 1, haveHeading = false;
  let beta = 0, gamma = 0, accuracy = null;
  let source = null;
  let sawRelative = false;
  let timer = null;
  let target = null;
  let unwrapped = 0;
  let lastDeg = null, lastDir = null, lastHint = null, lastOffset = null;

  function setState(next) {
    state = next;
    document.body.dataset.state = next;
  }

  function fail(kind) {
    clearTimeout(timer);
    stopListening();
    ui.errMsg.textContent = ERRORS[kind];
    setState('error');
  }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  // raw = heading of the device's top edge, clockwise from magnetic north.
  function feed(raw, e) {
    const h = norm(raw + screenAngle()) * RAD;
    if (!haveHeading) {
      sx = Math.sin(h);
      sy = Math.cos(h);
      haveHeading = true;
    } else {
      // Smooth on the unit circle so 359° -> 1° doesn't swing through 180°.
      sx += (Math.sin(h) - sx) * SMOOTH;
      sy += (Math.cos(h) - sy) * SMOOTH;
    }
    beta = e.beta || 0;
    gamma = e.gamma || 0;

    if (state === 'waiting') {
      clearTimeout(timer);
      setState('active');
      requestAnimationFrame(frame);
    }
  }

  // Chrome / Android: alpha is relative to magnetic north, counter-clockwise.
  function onAbsolute(e) {
    if (e.alpha == null) return;
    source = 'absolute';
    feed(360 - e.alpha, e);
  }

  function onOrientation(e) {
    // Safari / iOS
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      source = 'ios';
      accuracy = e.webkitCompassAccuracy;
      feed(e.webkitCompassHeading, e);
      return;
    }
    if (source === 'absolute') return;
    // Some browsers (e.g. Firefox) flag the regular event as absolute.
    if (e.absolute === true && e.alpha != null) {
      feed(360 - e.alpha, e);
      return;
    }
    if (e.alpha != null) sawRelative = true;
  }

  function stopListening() {
    window.removeEventListener('deviceorientationabsolute', onAbsolute, true);
    window.removeEventListener('deviceorientation', onOrientation, true);
  }

  async function start() {
    if (!window.isSecureContext) return fail('insecure');
    if (!('DeviceOrientationEvent' in window)) return fail('nosensor');

    // Safari (iOS 13+) and newer Chrome: must be called straight from a user tap.
    // `true` asks for absolute (magnetometer) orientation; Safari ignores the argument.
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission(true);
        if (res !== 'granted') return fail('denied');
      } catch (err) {
        return fail('denied');
      }
    }

    setState('waiting');
    window.addEventListener('deviceorientationabsolute', onAbsolute, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    timer = setTimeout(() => {
      if (!haveHeading) fail(sawRelative ? 'relative' : 'nosensor');
    }, SENSOR_TIMEOUT);
  }

  // ---- Render ----
  function currentHeading() {
    return norm(Math.atan2(sx, sy) / RAD);
  }

  function draw(h) {
    unwrapped += signedDiff(h, norm(unwrapped));
    ui.card.setAttribute('transform', `rotate(${(-unwrapped).toFixed(2)})`);

    // Letters stay upright while the card turns.
    for (const l of labels) {
      const t = (l.a - h) * RAD;
      l.node.setAttribute('x', (l.r * Math.sin(t)).toFixed(1));
      l.node.setAttribute('y', (-l.r * Math.cos(t)).toFixed(1));
    }
  }

  function setText(node, text, cacheKey) {
    if (text === cacheKey) return cacheKey;
    node.textContent = text;
    return text;
  }

  function frame() {
    if (state !== 'active') return;
    const h = currentHeading();
    draw(h);

    const deg = Math.round(h) % 360;
    lastDeg = setText(ui.deg, String(deg).padStart(3, '0'), lastDeg);

    const dir = DIRS[Math.round(h / 45) % 8];
    if (dir !== lastDir) {
      ui.dir.textContent = dir;
      ui.live.textContent = `Menghadap ${dir}`;
      lastDir = dir;
    }

    // Spirit level: bubble floats to the raised side.
    const clamp = (v) => Math.max(-45, Math.min(45, v));
    ui.bubble.setAttribute('cx', (-clamp(gamma) * 1.4).toFixed(1));
    ui.bubble.setAttribute('cy', (-clamp(beta) * 1.4).toFixed(1));

    let hint = '';
    if (source === 'ios' && (accuracy == null || accuracy < 0 || accuracy > 25)) {
      hint = 'Sinyal kompas lemah. Gerakkan HP membentuk angka 8 beberapa kali.';
    } else if (Math.hypot(beta, gamma) > 35) {
      hint = 'Pegang HP lebih mendatar biar arahnya akurat.';
    }
    lastHint = setText(ui.hint, hint, lastHint);

    if (target !== null) {
      const d = Math.round(signedDiff(target, h));
      const txt = Math.abs(d) <= 2
        ? `Pas di arah tanda (${target}°)`
        : `Tanda ${target}°: belok ${d > 0 ? 'kanan' : 'kiri'} ${Math.abs(d)}°`;
      lastOffset = setText(ui.offset, txt, lastOffset);
    }

    requestAnimationFrame(frame);
  }

  // ---- Bearing marker ----
  ui.mark.addEventListener('click', () => {
    target = Math.round(currentHeading()) % 360;
    ui.target.setAttribute('transform', `rotate(${target})`);
    ui.target.removeAttribute('hidden');
    ui.offset.hidden = false;
    ui.clear.hidden = false;
    ui.mark.textContent = 'Tandai ulang';
    lastOffset = null;
  });

  ui.clear.addEventListener('click', () => {
    target = null;
    ui.target.setAttribute('hidden', '');
    ui.offset.hidden = true;
    ui.clear.hidden = true;
    ui.mark.textContent = 'Tandai arah ini';
    ui.mark.focus();
  });

  ui.start.addEventListener('click', start);
  ui.retry.addEventListener('click', () => location.reload());

  // ---- Theme ----
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const activeTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

  function syncThemeUI() {
    const theme = activeTheme();
    ui.theme.setAttribute('aria-label', theme === 'dark' ? 'Pakai tema terang' : 'Pakai tema gelap');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--paper').trim());
  }

  ui.theme.addEventListener('click', () => {
    const next = activeTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('kompas-theme', next); } catch (e) {}
    syncThemeUI();
  });
  darkQuery.addEventListener('change', syncThemeUI);

  // ---- Boot ----
  draw(0);
  syncThemeUI();

  if (!window.isSecureContext) {
    fail('insecure');
  } else if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission !== 'function') {
    // Older browsers without a permission API: start right away.
    start();
  }
})();
