(() => {
  'use strict';

  const QUESTIONS_PER_SET = 10;
  const JAPAN_BOUNDS = [[30.8, 129.3], [45.5, 145.9]];
  const PALETTE = ['#f59f00', '#12b886', '#4c6ef5', '#e64980', '#7950f2', '#15aabf', '#82c91e'];
  const STORE_KEY = 'areaCodeQuiz.v1';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------- storage (optional; the quiz works without it) ----------
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function saveStore(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
  }
  const store = loadStore();

  // ---------- area data ----------
  const META = window.AREA_META;
  const objName = Object.keys(window.AREA_TOPO.objects)[0];
  const topoGeoms = window.AREA_TOPO.objects[objName].geometries;
  const features = topojson.feature(window.AREA_TOPO, window.AREA_TOPO.objects[objName]).features;
  const CODES = features.map((f) => f.properties.ab);

  // ---------- weak-code tracking ----------
  // A code is "weak" once answered wrong, until it is answered right OVERCOME_STREAK times in a row.
  const OVERCOME_STREAK = 2;
  const statOf = (code) => (store.stats && store.stats[code]) || { ok: 0, ng: 0, streak: 0 };
  const isWeak = (code) => { const s = statOf(code); return s.ng > 0 && (s.streak || 0) < OVERCOME_STREAK; };
  // Laplace-smoothed miss rate: higher = weaker
  const weakness = (code) => { const s = statOf(code); return (s.ng + 1) / (s.ok + s.ng + 2); };
  const weakCodes = () => CODES.filter(isWeak).sort((a, b) => weakness(b) - weakness(a));

  function pickWeakSet() {
    const pool = weakCodes().map((c) => ({ c, w: weakness(c) }));
    const picked = [];
    while (picked.length < QUESTIONS_PER_SET && pool.length) {
      let r = Math.random() * pool.reduce((sum, p) => sum + p.w, 0);
      let i = pool.findIndex((p) => (r -= p.w) <= 0);
      if (i < 0) i = pool.length - 1;
      picked.push(pool.splice(i, 1)[0].c);
    }
    // not enough weak codes: fill with never-asked codes first, then the rest
    const unseen = shuffle(CODES.filter((c) => !picked.includes(c) && !(store.stats && store.stats[c])));
    const rest = shuffle(CODES.filter((c) => !picked.includes(c) && !unseen.includes(c)));
    return shuffle(picked.concat(unseen, rest).slice(0, QUESTIONS_PER_SET));
  }

  // Greedy map coloring so neighbouring areas get different colors.
  const neighbors = topojson.neighbors(topoGeoms);
  const colorIdx = [];
  features.forEach((_, i) => {
    const used = new Set(neighbors[i].map((j) => colorIdx[j]).filter((c) => c !== undefined));
    let c = 0;
    while (used.has(c)) c++;
    colorIdx[i] = c % PALETTE.length;
  });

  function describe(code) {
    const m = META[code];
    let region = m.prefs.join('・');
    if (m.subs.length && m.prefs.length === 1) {
      region += '（' + m.subs.map((s) => s.replace(/(総合)?振興局$/, '')).join('・') + '）';
    }
    const shown = m.cities.slice(0, 4);
    const rest = m.cities.length - shown.length + m.towns;
    let places = shown.join('・');
    if (!places) places = `${m.towns}町村`;
    else if (rest > 0) places += ` <small>ほか${rest}市町村</small>`;
    return { region, places };
  }

  // ---------- map ----------
  const map = L.map('map', {
    zoomControl: true,
    minZoom: 4,
    maxZoom: 12,
    maxBounds: [[18, 115], [52, 160]],
    zoomSnap: 0.25,
    attributionControl: true,
  });
  map.fitBounds(JAPAN_BOUNDS);
  // GSI tiles (no API key): 淡色地図 with place names, 白地図 without them for "hard mode".
  const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a> | 局番: <a href="https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/shigai_list.html">総務省</a> | 境界: 国土数値情報';
  const gsi = (id) => `https://cyberjapandata.gsi.go.jp/xyz/${id}/{z}/{x}/{y}.png`;
  const labeledLayer = L.tileLayer(gsi('pale'), { attribution: ATTR, maxNativeZoom: 18 });
  const blankLayer = L.tileLayer(gsi('blank'), { attribution: ATTR, minNativeZoom: 5, maxNativeZoom: 14 });
  let showLabels = true;
  function setTiles() {
    const [on, off] = showLabels ? [labeledLayer, blankLayer] : [blankLayer, labeledLayer];
    map.removeLayer(off);
    if (!map.hasLayer(on)) on.addTo(map);
  }

  const areaLayers = new Map(); // code -> L.GeoJSON layer
  const labelPoints = new Map(); // code -> LatLng for the code badge

  function baseStyle(code) {
    const i = CODES.indexOf(code);
    return {
      color: dark.matches ? '#101216' : '#ffffff',
      weight: 1.2,
      fillColor: PALETTE[colorIdx[i]],
      fillOpacity: dark.matches ? 0.32 : 0.26,
      opacity: 1,
    };
  }

  features.forEach((f) => {
    const code = f.properties.ab;
    const layer = L.geoJSON(f, { style: () => baseStyle(code), smoothFactor: 0.6 }).addTo(map);
    layer.on('click', () => onAreaClick(code));
    layer.on('mouseover', () => onAreaHover(code, true));
    layer.on('mouseout', () => onAreaHover(code, false));
    areaLayers.set(code, layer);

    // badge position: center of the largest polygon piece
    let best = null, bestSize = -1;
    layer.eachLayer((poly) => {
      const b = poly.getBounds();
      const size = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
      if (size > bestSize) { bestSize = size; best = poly; }
    });
    labelPoints.set(code, best.getCenter());
  });

  dark.addEventListener('change', restyleAll);

  // ---------- quiz state ----------
  const state = {
    phase: 'idle', // idle | question | answered | done
    mode: 'normal', // normal | weak | review
    overcome: [],
    queue: [],
    index: 0,
    results: [],
    selected: null,
  };
  let badges = [];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function setPhase(p) {
    state.phase = p;
    app.dataset.phase = p;
  }

  function current() { return state.queue[state.index]; }

  function restyleAll() {
    const q = current();
    const last = state.results[state.index];
    areaLayers.forEach((layer, code) => {
      let s = baseStyle(code);
      if (state.phase === 'question' && code === state.selected) {
        s = { ...s, color: cssVar('--select'), weight: 3, fillColor: cssVar('--select'), fillOpacity: 0.45 };
      } else if (state.phase === 'answered') {
        if (code === q) s = { ...s, color: cssVar('--ok'), weight: 3, fillColor: cssVar('--ok'), fillOpacity: 0.55 };
        else if (last && !last.ok && code === last.picked) s = { ...s, color: cssVar('--ng'), weight: 3, fillColor: cssVar('--ng'), fillOpacity: 0.5 };
        else s = { ...s, fillOpacity: s.fillOpacity * 0.55 };
      }
      layer.setStyle(s);
    });
    if (state.phase === 'question' && state.selected) areaLayers.get(state.selected).bringToFront();
    if (state.phase === 'answered') {
      if (last && !last.ok && last.picked) areaLayers.get(last.picked).bringToFront();
      areaLayers.get(q).bringToFront();
    }
  }

  function clearBadges() {
    badges.forEach((b) => map.removeLayer(b));
    badges = [];
  }
  function addBadge(code) {
    const b = L.tooltip({ permanent: true, direction: 'center', className: 'area-label', interactive: false })
      .setLatLng(labelPoints.get(code))
      .setContent(code)
      .addTo(map);
    badges.push(b);
  }

  function renderProgress() {
    const dots = $('dots');
    dots.innerHTML = '';
    state.queue.forEach((_, i) => {
      const d = document.createElement('i');
      const r = state.results[i];
      if (r) d.className = r.ok ? 'ok' : 'ng';
      else if (i === state.index && state.phase !== 'done') d.className = 'cur';
      dots.appendChild(d);
    });
    const correct = state.results.filter((r) => r.ok).length;
    $('progressText').textContent = state.queue.length
      ? `${Math.min(state.index + 1, state.queue.length)} / ${state.queue.length}問・正解 ${correct}`
      : '';
  }

  const MODE_LABEL = { weak: '苦手克服', review: '復習' };

  function startSet(mode, codes) {
    state.mode = mode;
    state.queue = codes || (mode === 'weak' ? pickWeakSet() : shuffle(CODES).slice(0, QUESTIONS_PER_SET));
    state.index = 0;
    state.results = [];
    state.overcome = [];
    $('modeBadge').hidden = !MODE_LABEL[mode];
    $('modeBadge').textContent = MODE_LABEL[mode] || '';
    $('startScreen').hidden = true;
    $('resultScreen').hidden = true;
    showQuestion();
  }

  function showQuestion() {
    setPhase('question');
    state.selected = null;
    map.closePopup();
    clearBadges();
    $('qcode').textContent = current();
    $('feedback').hidden = true;
    $('hint').textContent = '地図でエリアをタップして選んでね';
    $('confirmBtn').hidden = false;
    $('confirmBtn').disabled = true;
    $('nextBtn').hidden = true;
    restyleAll();
    renderProgress();
    map.flyToBounds(JAPAN_BOUNDS, { duration: 0.6 });
  }

  function onAreaClick(code) {
    if (state.phase === 'question') {
      state.selected = code;
      $('confirmBtn').disabled = false;
      $('hint').textContent = 'このエリアでOK？ ほかをタップで選び直せるよ';
      restyleAll();
    } else if (state.phase === 'answered') {
      const d = describe(code);
      L.popup({ closeButton: false, autoPan: false, className: 'area-pop' })
        .setLatLng(labelPoints.get(code))
        .setContent(`<b style="font-size:16px">${code}</b><br>${d.region}<br>${d.places}`)
        .openOn(map);
    }
  }

  function onAreaHover(code, on) {
    if (!matchMedia('(hover: hover)').matches) return;
    const layer = areaLayers.get(code);
    if (state.phase === 'question' && code !== state.selected) {
      layer.setStyle(on ? { weight: 2.5, color: cssVar('--select') } : baseStyle(code));
    } else if (state.phase === 'answered') {
      if (on) layer.bindTooltip(code, { sticky: true, className: 'area-tip' }).openTooltip();
      else layer.unbindTooltip();
    }
  }

  function chip(code, kind, tag) {
    const d = describe(code);
    return `<div class="area-chip ${kind}"><span class="tag">${tag}</span><b>${code}</b><span class="place">${d.region}｜${d.places}</span></div>`;
  }

  function confirmAnswer() {
    if (state.phase !== 'question' || !state.selected) return;
    const q = current();
    const ok = state.selected === q;
    state.results[state.index] = { code: q, picked: state.selected, ok };
    setPhase('answered');

    const v = $('verdict');
    v.textContent = ok ? '正解！' : 'ざんねん…';
    v.className = 'verdict ' + (ok ? 'ok' : 'ng');
    $('answerDetail').innerHTML = chip(q, 'ok', '正解のエリア') + (ok ? '' : chip(state.selected, 'ng', 'あなたが選んだエリア'));
    $('feedback').hidden = false;
    $('hint').textContent = 'ほかのエリアをタップすると局番が見れるよ';
    $('confirmBtn').hidden = true;
    const last = state.index === state.queue.length - 1;
    $('nextBtn').textContent = last ? '結果を見る' : '次の問題へ';
    $('nextBtn').hidden = false;
    $('nextBtn').focus({ preventScroll: true });

    restyleAll();
    renderProgress();
    addBadge(q);
    if (!ok) addBadge(state.selected);

    const bounds = areaLayers.get(q).getBounds();
    if (!ok) bounds.extend(areaLayers.get(state.selected).getBounds());
    map.flyToBounds(bounds, { padding: [30, 30], maxZoom: 8, duration: 0.7 });

    // per-code stats drive the weak-code mode
    const wasWeak = isWeak(q);
    store.stats = store.stats || {};
    const s = store.stats[q] = store.stats[q] || { ok: 0, ng: 0, streak: 0 };
    if (ok) { s.ok++; s.streak = (s.streak || 0) + 1; } else { s.ng++; s.streak = 0; }
    saveStore(store);
    if (wasWeak && !isWeak(q)) {
      state.overcome.push(q);
      v.textContent = '正解！ 苦手を克服 🎉';
    } else if (ok && wasWeak) {
      v.textContent = `正解！ あと${OVERCOME_STREAK - s.streak}回連続で克服`;
    }
  }

  function next() {
    if (state.phase !== 'answered') return;
    if (state.index < state.queue.length - 1) {
      state.index++;
      showQuestion();
    } else {
      showResult();
    }
  }

  function showResult() {
    setPhase('done');
    clearBadges();
    map.closePopup();
    restyleAll();
    renderProgress();
    const total = state.queue.length;
    const score = state.results.filter((r) => r.ok).length;
    $('scoreNum').textContent = score;
    document.querySelector('.score small').textContent = `/ ${total}`;
    const rate = score / total;
    $('scoreMsg').textContent =
      rate === 1 ? 'パーフェクト！ 局番マスターだね 🎉'
      : rate >= 0.8 ? 'すごい、ほぼ完璧！あと少し！'
      : rate >= 0.5 ? 'いい感じ！間違えたとこを復習しよ'
      : 'まだまだこれから！くり返せば覚えられるよ';

    $('resultList').innerHTML = state.results.map((r) => {
      const d = describe(r.code);
      return `<li class="${r.ok ? 'ok' : 'ng'}"><span class="mark">${r.ok ? '○' : '×'}</span><span class="code">${r.code}</span><span class="where">${d.region}｜${d.places}</span></li>`;
    }).join('');

    const remaining = weakCodes().length;
    if (state.mode === 'weak') {
      $('scoreMsg').textContent += remaining
        ? `（残りの苦手：${remaining}個）`
        : '（苦手な局番はぜんぶ克服！）';
    }
    $('overcomeBox').hidden = state.overcome.length === 0;
    $('overcomeCodes').textContent = state.overcome.join('・');

    const wrong = state.results.filter((r) => !r.ok).map((r) => r.code);
    $('reviewBtn').hidden = wrong.length === 0;
    $('reviewBtn').onclick = () => startSet('review', shuffle(wrong));
    // "もう一回" in weak mode makes no sense once everything is overcome
    const retryMode = state.mode === 'weak' && !remaining ? 'normal' : state.mode === 'review' ? 'normal' : state.mode;
    $('retryBtn').textContent = retryMode === 'weak' ? '苦手克服をもう一回'
      : state.mode === 'normal' ? 'もう一回' : 'ふつうモードで10問';
    $('retryBtn').onclick = () => startSet(retryMode);

    if (state.mode === 'normal' && score > (store.best || 0)) {
      store.best = score;
      saveStore(store);
    }
    $('resultScreen').hidden = false;
    $('retryBtn').focus({ preventScroll: true });
  }

  // ---------- wiring ----------
  const labelToggle = $('labelToggle');
  if (typeof store.labels === 'boolean') labelToggle.checked = store.labels;
  function applyLabels() {
    showLabels = labelToggle.checked;
    setTiles();
    store.labels = showLabels;
    saveStore(store);
  }
  labelToggle.addEventListener('change', applyLabels);
  applyLabels();

  const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
  const selectedMode = () => modeRadios.find((r) => r.checked).value;

  function renderStartScreen() {
    const weak = weakCodes();
    const weakRadio = $('weakRadio');
    weakRadio.disabled = weak.length === 0;
    $('weakDesc').textContent = weak.length
      ? `苦手な${weak.length}個を中心に10問`
      : 'まだ苦手な局番はないよ';
    if (weakRadio.disabled && weakRadio.checked) modeRadios[0].checked = true;
    else if (!weakRadio.disabled && store.mode === 'weak') weakRadio.checked = true;

    $('weakBox').hidden = weak.length === 0;
    $('weakList').innerHTML = weak.slice(0, 12).map((c) => {
      const s = statOf(c);
      const rate = Math.round((s.ok / (s.ok + s.ng)) * 100);
      return `<li title="${describe(c).region}"><b>${c}</b><small>正解率${rate}%</small></li>`;
    }).join('') + (weak.length > 12 ? `<li class="more">ほか${weak.length - 12}個</li>` : '');

    $('bestText').textContent = store.best ? `自己ベスト（ふつう）：${store.best} / ${QUESTIONS_PER_SET}` : '';
  }

  function showMenu() {
    setPhase('idle');
    state.queue = [];
    state.results = [];
    clearBadges();
    map.closePopup();
    restyleAll();
    renderProgress();
    $('qcode').textContent = '---';
    $('modeBadge').hidden = true;
    $('resultScreen').hidden = true;
    renderStartScreen();
    $('startScreen').hidden = false;
  }

  $('resetBtn').addEventListener('click', () => {
    if (!confirm('局番ごとの成績（苦手リスト）をリセットする？')) return;
    delete store.stats;
    saveStore(store);
    renderStartScreen();
  });
  modeRadios.forEach((r) => r.addEventListener('change', () => { store.mode = selectedMode(); saveStore(store); }));
  renderStartScreen();

  $('startBtn').addEventListener('click', () => startSet(selectedMode()));
  $('menuBtn').addEventListener('click', showMenu);
  $('confirmBtn').addEventListener('click', confirmAnswer);
  $('nextBtn').addEventListener('click', next);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    if (state.phase === 'question') confirmAnswer();
    else if (state.phase === 'answered') next();
  });

  // Leaflet needs a size recalculation when the grid changes (rotation / resize).
  new ResizeObserver(() => map.invalidateSize()).observe($('map'));
})();
