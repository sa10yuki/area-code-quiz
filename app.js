(() => {
  'use strict';

  const QUESTIONS_PER_SET = 10;
  const JAPAN_BOUNDS = [[30.8, 129.3], [45.5, 145.9]];
  // No blues: the sea is bluish, so area fills stay in warm / green / purple hues.
  const PALETTE_LIGHT = ['#f6cf7d', '#9fd9b9', '#f3b2c7', '#cdb8f0', '#cde596', '#f4bb97'];
  const PALETTE_DARK = ['#80652e', '#2e6e52', '#81455b', '#5a4a86', '#5a722b', '#7f5236'];
  const STORE_KEY = 'areaCodeQuiz.v1';
  const LEVELS = {
    3: { eyebrow: '頭3桁でおぼえる', pattern: '0AB', zoom: 8 },
    4: { eyebrow: '頭4桁でおぼえる', pattern: '0ABC', zoom: 9 },
  };

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
  // 3-digit records keep their original keys so existing progress survives.
  const statsKey = () => (DS.level === 3 ? 'stats' : `stats${DS.level}`);
  const bestKey = () => (DS.level === 3 ? 'best' : `best${DS.level}`);
  const levelStats = () => store[statsKey()] || {};

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
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
  // No basemap tiles (they all print place names): the sea is the map background,
  // land is the area fills, and prefecture borders are drawn from our own data.
  map.attributionControl.addAttribution('局番: <a href="https://www.soumu.go.jp/main_sosiki/joho_tsusin/top/tel_number/shigai_list.html">総務省</a> | 境界: 国土数値情報');
  map.createPane('lines');
  map.getPane('lines').style.zIndex = 450;
  map.getPane('lines').style.pointerEvents = 'none';
  const prefLineStyle = () => ({ color: cssVar('--pref-line'), weight: 1.2, dashArray: '4 3', opacity: 0.8 });

  // ---------- datasets (one per digit level) ----------
  const datasets = {};
  let DS = null; // the active dataset

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function getDataset(level) {
    if (datasets[level]) return datasets[level];
    if (!(window.AREA_DATA && window.AREA_DATA[level])) await loadScript(`data/areas${level}.js`);
    const { topo, meta } = window.AREA_DATA[level];
    const geoms = topo.objects.areas.geometries;
    const features = topojson.feature(topo, topo.objects.areas).features;
    const codes = features.map((f) => f.properties.ab);
    const ds = {
      level,
      meta,
      codes,
      sorted: codes.slice().sort(),
      // in the 4-digit level, codes that are only 2–3 digits stay on the map as
      // choices but are not asked (they are the 3-digit level's questions)
      quizCodes: codes.filter((c) => c.length === level),
      colorIdx: new Map(),
      layers: new Map(), // code -> L.GeoJSON
      labelPoints: new Map(), // code -> LatLng for the code badge
      mainPieces: new Map(), // code -> largest polygon piece (for label visibility)
      group: L.layerGroup(),
    };

    // Greedy map coloring so neighbouring areas get different colors.
    const neighbors = topojson.neighbors(geoms);
    const idx = [];
    features.forEach((f, i) => {
      const used = new Set(neighbors[i].map((j) => idx[j]).filter((c) => c !== undefined));
      let c = 0;
      while (used.has(c)) c++;
      idx[i] = c % PALETTE_LIGHT.length;
      ds.colorIdx.set(f.properties.ab, idx[i]);
    });

    features.forEach((f) => {
      const code = f.properties.ab;
      const layer = L.geoJSON(f, { style: () => baseStyle(code, ds), smoothFactor: 0.6 });
      layer.on('click', () => onAreaClick(code));
      layer.on('mouseover', () => onAreaHover(code, true));
      layer.on('mouseout', () => onAreaHover(code, false));
      ds.layers.set(code, layer);
      ds.group.addLayer(layer);
    });

    ds.prefLines = L.geoJSON(topojson.feature(topo, topo.objects.preflines), {
      pane: 'lines', interactive: false, style: prefLineStyle,
    });
    ds.group.addLayer(ds.prefLines);
    datasets[level] = ds;
    return ds;
  }

  function useDataset(ds) {
    if (DS === ds) return;
    if (DS) map.removeLayer(DS.group);
    DS = ds;
    DS.group.addTo(map);
    // Polygon#getCenter only works once the layer is on the map, so badge
    // positions (center of each area's largest piece) are computed here, once.
    if (!DS.labelPoints.size) {
      DS.layers.forEach((layer, code) => {
        let best = null, bestSize = -1;
        layer.eachLayer((poly) => {
          const b = poly.getBounds();
          const size = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
          if (size > bestSize) { bestSize = size; best = poly; }
        });
        DS.labelPoints.set(code, best.getCenter());
        DS.mainPieces.set(code, best);
      });
    }
    restyleAll();
  }

  function baseStyle(code, ds = DS) {
    return {
      color: dark.matches ? '#16181c' : '#ffffff',
      weight: 1.2,
      fillColor: (dark.matches ? PALETTE_DARK : PALETTE_LIGHT)[ds.colorIdx.get(code)],
      fillOpacity: 1,
      opacity: 1,
    };
  }

  dark.addEventListener('change', () => {
    if (!DS) return;
    restyleAll();
    DS.prefLines.setStyle(prefLineStyle());
  });

  // ---------- area descriptions ----------
  function regionOf(code) {
    const m = DS.meta[code];
    let region = m.prefs.join('・');
    if (m.subs.length && m.prefs.length === 1) {
      region += '（' + m.subs.map((s) => s.replace(/(総合)?振興局$/, '')).join('・') + '）';
    }
    return region;
  }

  function describe(code) {
    const m = DS.meta[code];
    // small 4-digit areas often have no city at all, so fall back to town names
    const names = m.cities.length ? m.cities : m.towns;
    const shown = names.slice(0, 4);
    const rest = m.cities.length + m.towns.length - shown.length;
    let places = shown.join('・');
    if (rest > 0) places += ` <small>ほか${rest}市町村</small>`;
    return { region: regionOf(code), places };
  }

  const fullPlaces = (code) => {
    const m = DS.meta[code];
    return m.cities.concat(m.towns).join('・');
  };

  // ---------- weak-code tracking ----------
  // A code is "weak" once answered wrong, until it is answered right OVERCOME_STREAK times in a row.
  const OVERCOME_STREAK = 2;
  const statOf = (code) => levelStats()[code] || { ok: 0, ng: 0, streak: 0 };
  const isWeak = (code) => { const s = statOf(code); return s.ng > 0 && (s.streak || 0) < OVERCOME_STREAK; };
  // Laplace-smoothed miss rate: higher = weaker
  const weakness = (code) => { const s = statOf(code); return (s.ng + 1) / (s.ok + s.ng + 2); };
  const weakCodes = () => DS.quizCodes.filter(isWeak).sort((a, b) => weakness(b) - weakness(a));

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
    const stats = levelStats();
    const unseen = shuffle(DS.quizCodes.filter((c) => !picked.includes(c) && !stats[c]));
    const rest = shuffle(DS.quizCodes.filter((c) => !picked.includes(c) && !unseen.includes(c)));
    return shuffle(picked.concat(unseen, rest).slice(0, QUESTIONS_PER_SET));
  }

  // ---------- quiz state ----------
  const state = {
    phase: 'idle', // idle | question | answered | done | browse
    mode: 'normal', // normal | weak | review
    overcome: [],
    queue: [],
    index: 0,
    results: [],
    selected: null,
  };
  let badges = [];

  function setPhase(p) {
    state.phase = p;
    app.dataset.phase = p;
  }

  function current() { return state.queue[state.index]; }

  function restyleAll() {
    if (!DS) return;
    const q = current();
    const last = state.results[state.index];
    const selectable = state.phase === 'question' || state.phase === 'browse';
    DS.layers.forEach((layer, code) => {
      let s = baseStyle(code);
      if (selectable && code === state.selected) {
        s = { ...s, color: cssVar('--select'), weight: 3, fillColor: cssVar('--select-fill') };
      } else if (state.phase === 'answered') {
        if (code === q) s = { ...s, color: cssVar('--ok'), weight: 3, fillColor: cssVar('--ok-fill') };
        else if (last && !last.ok && code === last.picked) s = { ...s, color: cssVar('--ng'), weight: 3, fillColor: cssVar('--ng-fill') };
        else s = { ...s, fillColor: cssVar('--land-dim') };
      }
      layer.setStyle(s);
    });
    if (selectable && state.selected) DS.layers.get(state.selected).bringToFront();
    if (state.phase === 'answered') {
      if (last && !last.ok && last.picked) DS.layers.get(last.picked).bringToFront();
      DS.layers.get(q).bringToFront();
    }
  }

  function clearBadges() {
    badges.forEach((b) => map.removeLayer(b));
    badges = [];
  }
  function addBadge(code, className = 'area-label big') {
    const b = L.tooltip({ permanent: true, direction: 'center', className, interactive: false })
      .setLatLng(DS.labelPoints.get(code))
      .setContent(code)
      .addTo(map);
    b.code = code;
    badges.push(b);
    return b;
  }

  // Browse mode shows every code on the map; hide labels whose area is too small
  // on screen at the current zoom so they don't pile up (e.g. around Tokyo).
  function updateBrowseLabels() {
    if (state.phase !== 'browse') return;
    badges.forEach((b) => {
      const bounds = DS.mainPieces.get(b.code).getBounds();
      const nw = map.latLngToContainerPoint(bounds.getNorthWest());
      const se = map.latLngToContainerPoint(bounds.getSouthEast());
      const minW = b.code.length >= 4 ? 42 : 34;
      const fits = se.x - nw.x >= minW && se.y - nw.y >= 22;
      const el = b.getElement();
      if (el) el.style.display = fits || b.code === state.selected ? '' : 'none';
    });
  }
  map.on('zoomend', updateBrowseLabels);

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
    state.queue = codes || (mode === 'weak' ? pickWeakSet() : shuffle(DS.quizCodes).slice(0, QUESTIONS_PER_SET));
    state.index = 0;
    state.results = [];
    state.overcome = [];
    const badge = [`${DS.level}桁`, MODE_LABEL[mode]].filter(Boolean).join('・');
    $('modeBadge').textContent = badge;
    $('modeBadge').hidden = false;
    $('modeBadge').classList.toggle('plain', !MODE_LABEL[mode]);
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
    if (state.phase === 'browse') {
      selectBrowse(code, false);
    } else if (state.phase === 'question') {
      state.selected = code;
      $('confirmBtn').disabled = false;
      $('hint').textContent = 'このエリアでOK？ ほかをタップで選び直せるよ';
      restyleAll();
    } else if (state.phase === 'answered') {
      const d = describe(code);
      L.popup({ closeButton: false, autoPan: false, className: 'area-pop' })
        .setLatLng(DS.labelPoints.get(code))
        .setContent(`<b style="font-size:16px">${code}</b><br>${d.region}<br>${d.places}`)
        .openOn(map);
    }
  }

  function onAreaHover(code, on) {
    if (!matchMedia('(hover: hover)').matches) return;
    const layer = DS.layers.get(code);
    if ((state.phase === 'question' || state.phase === 'browse') && code !== state.selected) {
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

    const bounds = DS.layers.get(q).getBounds();
    if (!ok) bounds.extend(DS.layers.get(state.selected).getBounds());
    map.flyToBounds(bounds, { padding: [30, 30], maxZoom: LEVELS[DS.level].zoom, duration: 0.7 });

    // per-code stats drive the weak-code mode
    const wasWeak = isWeak(q);
    const stats = store[statsKey()] = levelStats();
    const s = stats[q] = stats[q] || { ok: 0, ng: 0, streak: 0 };
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

    if (state.mode === 'normal' && score > (store[bestKey()] || 0)) {
      store[bestKey()] = score;
      saveStore(store);
    }
    $('resultScreen').hidden = false;
    $('retryBtn').focus({ preventScroll: true });
  }

  // ---------- browse mode ----------
  const toHalfWidth = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  function matchesQuery(code, query) {
    const q = toHalfWidth(query.trim());
    if (!q) return true;
    if (/^\d+$/.test(q)) return code.startsWith(q) || code.startsWith('0' + q);
    const m = DS.meta[code];
    return m.prefs.some((p) => p.includes(q) || q.includes(p))
      || m.subs.some((s) => s.includes(q))
      || m.cities.some((c) => c.includes(q))
      || m.towns.some((t) => t.includes(q));
  }

  function renderCodeList() {
    const query = $('search').value;
    const hits = DS.sorted.filter((c) => matchesQuery(c, query));
    $('codeList').innerHTML = hits.length
      ? hits.map((c) => `<li><button type="button" data-code="${c}" class="${c === state.selected ? 'on' : ''}"><b>${c}</b><span>${regionOf(c)}</span></button></li>`).join('')
      : '<li class="no-hit">見つからなかった…</li>';
    return hits;
  }

  function renderBrowseDetail(code) {
    const s = levelStats()[code];
    const record = s ? `<p class="bd-stat">あなたの成績：${s.ok}勝 ${s.ng}敗${isWeak(code) ? '（苦手）' : ''}</p>` : '';
    $('browseDetail').innerHTML = `
      <div class="bd-head"><b class="bd-code">${code}</b><span class="bd-region">${regionOf(code)}</span></div>
      <p class="bd-places">${fullPlaces(code)}</p>${record}`;
  }

  function selectBrowse(code, fly) {
    state.selected = code;
    restyleAll();
    renderBrowseDetail(code);
    renderCodeList();
    updateBrowseLabels();
    const btn = $('codeList').querySelector(`[data-code="${code}"]`);
    if (btn) btn.scrollIntoView({ block: 'nearest' });
    if (fly) map.flyToBounds(DS.layers.get(code).getBounds(), { padding: [30, 30], maxZoom: LEVELS[DS.level].zoom, duration: 0.6 });
  }

  function startBrowse() {
    setPhase('browse');
    state.queue = [];
    state.results = [];
    state.selected = null;
    map.closePopup();
    clearBadges();
    DS.codes.forEach((c) => addBadge(c, 'area-label'));
    $('startScreen').hidden = true;
    $('resultScreen').hidden = true;
    $('search').value = '';
    $('search').placeholder = DS.level === 3 ? '局番・地名で検索（例: 045、札幌）' : '局番・地名で検索（例: 0466、帯広）';
    $('browseDetail').innerHTML = '<p class="browse-empty">地図のエリアか、下の一覧から選んでね</p>';
    renderCodeList();
    restyleAll();
    renderProgress();
    $('progressText').textContent = `閲覧モード（${DS.level}桁）`;
    map.flyToBounds(JAPAN_BOUNDS, { duration: 0.6 });
    // labels are measured after the fly animation settles
    map.once('moveend', updateBrowseLabels);
    updateBrowseLabels();
  }

  $('search').addEventListener('input', renderCodeList);
  $('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = DS.sorted.find((c) => matchesQuery(c, $('search').value));
    if (first) selectBrowse(first, true);
  });
  $('codeList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-code]');
    if (btn) selectBrowse(btn.dataset.code, true);
  });
  $('browseBtn').addEventListener('click', startBrowse);
  $('browseExitBtn').addEventListener('click', () => showMenu());

  // ---------- start screen ----------
  const modeRadios = [...document.querySelectorAll('input[name="mode"]')];
  const selectedMode = () => modeRadios.find((r) => r.checked).value;
  const levelTabs = [...document.querySelectorAll('.level-tab')];

  function renderStartScreen() {
    const cfg = LEVELS[DS.level];
    levelTabs.forEach((t) => {
      const on = +t.dataset.level === DS.level;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    });
    $('levelEyebrow').textContent = cfg.eyebrow;
    $('levelPattern').textContent = cfg.pattern;
    $('areaCount').textContent = `${DS.codes.length}エリア`;
    $('normalDesc').textContent = `${DS.quizCodes.length}個の局番からランダムに10問`;
    $('levelNote').hidden = DS.level === 3;

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
      return `<li title="${regionOf(c)}"><b>${c}</b><small>正解率${rate}%</small></li>`;
    }).join('') + (weak.length > 12 ? `<li class="more">ほか${weak.length - 12}個</li>` : '');

    const best = store[bestKey()];
    $('bestText').textContent = best ? `自己ベスト（${DS.level}桁・ふつう）：${best} / ${QUESTIONS_PER_SET}` : '';
  }

  async function switchLevel(level) {
    if (DS && DS.level === level) return;
    const sheet = $('startScreen').querySelector('.sheet');
    sheet.classList.add('loading');
    try {
      useDataset(await getDataset(level));
      store.level = level;
      saveStore(store);
    } catch (err) {
      alert('地図データを読み込めなかった…通信状況を確認してね');
    } finally {
      sheet.classList.remove('loading');
      renderStartScreen();
    }
  }

  levelTabs.forEach((t) => t.addEventListener('click', () => switchLevel(+t.dataset.level)));
  // arrow keys move between tabs (WAI-ARIA tabs pattern)
  $('levelTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = levelTabs.findIndex((t) => +t.dataset.level === DS.level);
    const nextTab = levelTabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + levelTabs.length) % levelTabs.length];
    nextTab.focus();
    switchLevel(+nextTab.dataset.level);
  });

  function showMenu() {
    setPhase('idle');
    state.queue = [];
    state.results = [];
    state.selected = null;
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
    if (!confirm(`${DS.level}桁モードの成績（苦手リスト）をリセットする？`)) return;
    delete store[statsKey()];
    saveStore(store);
    renderStartScreen();
  });
  modeRadios.forEach((r) => r.addEventListener('change', () => { store.mode = selectedMode(); saveStore(store); }));

  $('startBtn').addEventListener('click', () => startSet(selectedMode()));
  $('menuBtn').addEventListener('click', showMenu);
  $('quitBtn').addEventListener('click', () => {
    // answers are saved to stats one by one, so quitting only drops the unfinished set
    if (state.results.length && !confirm('クイズを中断してメニューに戻る？\n（ここまでの回答は苦手リストに記録済みだよ）')) return;
    showMenu();
  });
  $('confirmBtn').addEventListener('click', confirmAnswer);
  $('nextBtn').addEventListener('click', next);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
    if (state.phase === 'question') confirmAnswer();
    else if (state.phase === 'answered') next();
  });

  // Leaflet needs a size recalculation when the grid changes (rotation / resize).
  new ResizeObserver(() => map.invalidateSize()).observe($('map'));

  // ---------- boot ----------
  (async () => {
    const level = LEVELS[store.level] ? store.level : 3;
    try {
      useDataset(await getDataset(level));
    } catch {
      useDataset(await getDataset(3)); // the 3-digit data ships with the page
    }
    renderStartScreen();
  })();
})();
