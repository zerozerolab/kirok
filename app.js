'use strict';
/*
 * 복용 기록표
 * - 외부 전송 없음: fetch/XHR/분석 코드 없음. 저장은 이 기기의 localStorage만 사용.
 * - 사용자 입력은 textContent로만 표시 (innerHTML 미사용).
 * - 기록은 7일이 지나면 자동 삭제.
 */
(function () {
  // ---------- 상수 ----------
  var STORE_KEY = 'kirok.v1';
  var HOUR = 60 * 60 * 1000;
  var DAY = 24 * HOUR;
  var KEEP_MS = 7 * DAY;          // 기록 보관 기간
  var RECENT_MS = 30 * HOUR;      // 상태·곡선에 반영하는 "최근 복용" 범위
  var PROFILE_HOURS = 36;         // 한 번 복용의 곡선을 계산하는 길이
  var SVGNS = 'http://www.w3.org/2000/svg';
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  // ---------- 약 정보 (공식 허가문서 수치) ----------
  // comps: 곡선 모양을 만드는 성분 목록
  //   [가중치, 지연(시간), 최고점 시간]            → 한 번에 흡수되는 형태
  //   [가중치, 지연(시간), 방출 끝 시간, 'steady'] → 일정 속도로 녹다가 끝나면 반감기대로 감소 (OROS 서방정)
  // note: [항목, 내용, 'strong'(선택: 굵게)]
  // curve: false → 곡선 대신 최근 7일 복용 체크를 보여줌
  var DRUGS = {
    concerta: {
      name: '콘서타',
      desc: '천천히 녹는 알약 · 하루 1번 아침',
      doses: [18, 27, 36, 54],
      tmaxText: '6~10시간 (18mg 평균 6.8시간)',
      tmaxRange: [6, 10],
      halfText: '약 3.5시간',
      halfLife: 3.5,
      comps: [[0.15, 0, 1.5], [0.85, 0, 7, 'steady']],
      note: [],
      source: {
        label: '미국 FDA 공식 허가문서 (2026, 영문) · 약동학 항목',
        url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021121s054lbl.pdf'
      }
    },
    medikinet: {
      name: '메디키넷',
      desc: '천천히 녹는 캡슐 · 식사와 함께',
      doses: [5, 10, 20],
      tmaxText: '평균 약 2시간 45분',
      tmaxRange: [2.75, 2.75],
      halfText: '약 3.2시간',
      halfLife: 3.2,
      comps: [[0.55, 0, 1.25], [0.45, 2, 1.5]],
      note: [
        ['기름진 식사', '1시간 반쯤 늦게 오름']
      ],
      source: {
        label: '영국 의약품청 공식 허가문서 (Medikinet XL, 영문) · 5.2항',
        url: 'https://www.medicines.org.uk/emc/product/313/smpc'
      }
    },
    atomoxetine: {
      name: '아토목세틴',
      curve: false,
      desc: '스트라테라 등 같은 성분 약',
      doses: [10, 18, 25, 40, 60, 80],
      tmaxText: '약 1시간',
      tmaxRange: [1, 1],
      halfText: '평균 5.2시간',
      halfLife: 5.2,
      comps: [[1, 0, 1]],
      note: [
        ['효과', '몇 주 꾸준히 먹어야 나타남', 'strong'],
        ['하루 곡선', '효과 있는 시간과는 무관']
      ],
      source: {
        label: '미국 FDA 공식 허가문서 (2026, 영문) · 약동학 항목',
        url: 'https://www.accessdata.fda.gov/drugsatfda_docs/label/2026/021411s053lbl.pdf'
      }
    }
  };
  var DRUG_ORDER = ['concerta', 'medikinet', 'atomoxetine'];

  function isDrug(key) { return Object.prototype.hasOwnProperty.call(DRUGS, key); }
  function hasCurve(key) { return DRUGS[key].curve !== false; }

  // ---------- 곡선 모형 ----------
  // 최고점 시간(tmax)이 주어졌을 때 흡수 속도(ka)를 이분법으로 찾음
  function kaFor(tmax, ke) {
    var lo = 0.001, hi = 50;
    for (var i = 0; i < 120; i++) {
      var m = (lo + hi) / 2;
      var t = Math.abs(m - ke) < 1e-9 ? 1 / ke : Math.log(m / ke) / (m - ke);
      if (t > tmax) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }

  function componentShape(c, ke) {
    if (c[3] === 'steady') {
      var end = c[2];
      return function (x) {
        return x < end ? 1 - Math.exp(-ke * x) : (1 - Math.exp(-ke * end)) * Math.exp(-ke * (x - end));
      };
    }
    var ka = kaFor(c[2], ke);
    return function (x) { return Math.exp(-ke * x) - Math.exp(-ka * x); };
  }

  // 복용 후 경과 시간(시간) → 0~1 상대 농도. 약마다 한 번만 계산해 둠.
  var profileCache = {};
  function profile(key) {
    if (profileCache[key]) return profileCache[key];
    var d = DRUGS[key];
    var ke = Math.LN2 / d.halfLife;
    var parts = d.comps.map(function (c) {
      var g = componentShape(c, ke);
      return { w: c[0], lag: c[1], g: g, peak: g(c[2]) };
    });
    function raw(h) {
      var s = 0;
      parts.forEach(function (p) {
        var x = h - p.lag;
        if (x > 0) s += p.w * p.g(x) / p.peak;
      });
      return s;
    }

    // 0.05시간 간격으로 계산한 뒤 약 1시간 폭으로 부드럽게 다듬음 (방출이 끝나는 지점의 꺾임 완화).
    // 시작 부분은 창을 좁혀서 복용 직후 모양이 앞당겨지지 않게 함.
    var STEP = 0.05, N = PROFILE_HOURS / STEP, HALF = 10;
    var grid = [], smooth = [], i, k;
    for (i = 0; i <= N; i++) grid.push(raw(i * STEP));
    for (i = 0; i <= N; i++) {
      var hw = Math.min(HALF, i, N - i), sum = 0;
      for (k = i - hw; k <= i + hw; k++) sum += grid[k];
      smooth.push(sum / (2 * hw + 1));
    }
    var max = Math.max.apply(null, smooth);

    var fn = function (hours) {
      if (hours <= 0 || hours >= PROFILE_HOURS) return 0;
      var pos = hours / STEP, lo = Math.floor(pos), f = pos - lo;
      return (smooth[lo] * (1 - f) + smooth[Math.min(lo + 1, N)] * f) / max;
    };
    profileCache[key] = fn;
    return fn;
  }

  // ---------- 상태와 저장 ----------
  var state = { records: [], selected: 'concerta', dose: {} };
  var justAdded = null;   // 방금 기록한 줄을 잠깐 강조하기 위한 표시

  // 허가 용량 목록에 있는 값만 허용
  function isValidDose(drug, v) { return isDrug(drug) && DRUGS[drug].doses.indexOf(v) !== -1; }
  function currentDose() {
    var v = state.dose[state.selected];
    return isValidDose(state.selected, v) ? v : null;
  }

  function isValidRecord(r) {
    return !!r && typeof r === 'object' &&
      typeof r.id === 'string' && /^[a-z0-9]{1,24}$/.test(r.id) &&
      typeof r.drug === 'string' && isDrug(r.drug) &&
      typeof r.t === 'number' && isFinite(r.t) &&
      (r.dose === undefined || r.dose === null || isValidDose(r.drug, r.dose));
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      if (Array.isArray(data.records)) state.records = data.records.filter(isValidRecord);
      if (DRUG_ORDER.indexOf(data.selected) !== -1) state.selected = data.selected;
      if (data.dose && typeof data.dose === 'object') {
        DRUG_ORDER.forEach(function (k) { if (isValidDose(k, data.dose[k])) state.dose[k] = data.dose[k]; });
      }
    } catch (e) { /* 저장소를 쓸 수 없어도 화면은 동작 */ }
  }

  // 7일 지난 기록과 하루 넘게 미래인 기록 제거
  function prune() {
    var now = Date.now();
    state.records = state.records.filter(function (r) { return r.t >= now - KEEP_MS && r.t <= now + DAY; });
  }

  function save() {
    prune();
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        records: state.records, selected: state.selected, dose: state.dose
      }));
    } catch (e) { /* 저장 실패해도 화면은 동작 */ }
  }

  function newId() {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 24);
  }

  function addRecord(drug, t) {
    if (!isDrug(drug)) return;
    var rec = { id: newId(), drug: drug, t: t };
    var dose = currentDose();
    if (dose !== null) rec.dose = dose;
    state.records.push(rec);
    state.records.sort(function (a, b) { return a.t - b.t; });
    justAdded = rec.id;
    save();
    render();
    justAdded = null;
  }

  function removeRecord(id) {
    state.records = state.records.filter(function (r) { return r.id !== id; });
    save();
    render();
  }

  // ---------- 날짜·시간·문구 ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function ampmText(t) {
    var d = new Date(t), h = d.getHours();
    return (h < 12 ? '오전 ' : '오후 ') + (h % 12 === 0 ? 12 : h % 12) + ':' + pad(d.getMinutes());
  }
  function doseText(r) { return isValidDose(r.drug, r.dose) ? r.dose + 'mg' : ''; }
  function nameWithDose(r) { var dose = doseText(r); return DRUGS[r.drug].name + (dose ? ' ' + dose : ''); }

  // ---------- DOM 도우미 ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    return n;
  }
  function svgText(attrs, text) { var t = svg('text', attrs); t.textContent = text; return t; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function radio(cls, label, checked, onClick) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }
  function fillFacts(dl, rows) {
    clear(dl);
    rows.forEach(function (row) {
      dl.appendChild(el('dt', null, row[0]));
      var dd = el('dd');
      if (row[2] === 'strong') dd.appendChild(el('strong', null, row[1]));
      else dd.textContent = row[1];
      dl.appendChild(dd);
    });
  }

  // ---------- 기록 조회 ----------
  function latest(filter, now) {
    var last = null;
    state.records.forEach(function (r) {
      if (r.t <= now && filter(r) && (!last || r.t > last.t)) last = r;
    });
    return last;
  }
  function recentCurveDose(now) {
    var r = latest(function (x) { return hasCurve(x.drug); }, now);
    return r && r.t >= now - RECENT_MS ? r : null;
  }

  // ---------- 곡선 계산 ----------
  // 그래프 가로 범위: 오늘 6시~24시 (6시 전 기록이 있으면 그 시각부터)
  function chartRange(now) {
    var day = startOfDay(now), start = day + 6 * HOUR;
    state.records.forEach(function (r) {
      if (r.t >= day && r.t < start) start = Math.floor(r.t / HOUR) * HOUR;
    });
    return { start: start, end: day + DAY };
  }

  // 곡선이 있는 약의 기록을 모두 더한 상대 농도 (전날 복용분 포함)
  function curveRecords(start, end) {
    return state.records.filter(function (r) {
      return hasCurve(r.drug) && r.t > start - PROFILE_HOURS * HOUR && r.t <= end;
    });
  }
  function levelAt(recs, t) {
    var v = 0;
    recs.forEach(function (r) { v += profile(r.drug)((t - r.t) / HOUR); });
    return v;
  }

  // 지금 상태 한 단어. 기준은 위 곡선 모형: 오늘 곡선 최고점의 80% 이상이면 '가장 높을 때',
  // 최고점 전이면 '오르는 중', 25% 이상이면 '내려가는 중', 그 아래는 '거의 빠짐'.
  function curveWord(recs, range, now) {
    var peakV = 0, peakT = range.start, step = (range.end - range.start) / 180;
    for (var t = range.start; t <= range.end + 1; t += step) {
      var v = levelAt(recs, t);
      if (v > peakV) { peakV = v; peakT = t; }
    }
    if (peakV <= 0) return '거의 빠짐';
    var ratio = levelAt(recs, now) / peakV;
    if (ratio >= 0.8) return '가장 높을 때';
    if (now < peakT) return '오르는 중';
    if (ratio >= 0.25) return '내려가는 중';
    return '거의 빠짐';
  }

  // ---------- 화면: 곡선 ----------
  var C = { L: 8, R: 352, T: 34, B: 168 };   // viewBox 360x196 안의 그림 영역

  function renderChart(now, recs, range) {
    var s = $('chart');
    clear(s);
    var x = function (t) { return C.L + (t - range.start) / (range.end - range.start) * (C.R - C.L); };

    // 6시간 눈금
    for (var t = Math.ceil(range.start / HOUR) * HOUR; t <= range.end; t += HOUR) {
      var hr = new Date(t).getHours();
      if (hr % 6 !== 0) continue;
      var tx = x(t), edge = tx < C.L + 16 ? 'start' : (tx > C.R - 16 ? 'end' : 'middle');
      s.appendChild(svgText({ x: tx, y: C.B + 20, 'class': 'ax-text', 'text-anchor': edge }, (hr === 0 ? 24 : hr) + '시'));
    }
    s.appendChild(svg('line', { x1: C.L, y1: C.B, x2: C.R, y2: C.B, 'class': 'ax' }));

    var pts = [], step = (range.end - range.start) / 180;
    for (var u = range.start; u <= range.end + 1; u += step) pts.push([u, levelAt(recs, u)]);
    var scale = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p[1]; })));
    var y = function (v) { return C.B - (v / scale) * (C.B - C.T); };
    var toPath = function (list) {
      return list.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1); }).join('');
    };

    // 앞으로의 곡선은 연하게, 지나온 곡선은 진하게
    var nowV = levelAt(recs, now);
    var past = pts.filter(function (p) { return p[0] < now; }).concat([[now, nowV]]);
    s.appendChild(svg('path', { d: toPath(pts), 'class': 'curve-future' }));
    s.appendChild(svg('path', { d: toPath(past) + 'L' + x(now).toFixed(1) + ',' + C.B + 'L' + C.L + ',' + C.B + 'Z', 'class': 'area-past' }));
    s.appendChild(svg('path', { d: toPath(past), 'class': 'curve-past' }));

    // 지금 위치
    if (now >= range.start && now <= range.end) {
      var nx = x(now), ny = y(nowV);
      var anchor = nx < C.L + 40 ? 'start' : (nx > C.R - 40 ? 'end' : 'middle');
      s.appendChild(svg('line', { x1: nx, y1: ny, x2: nx, y2: C.B, 'class': 'now-line' }));
      s.appendChild(svg('circle', { cx: nx, cy: ny, r: 11, 'class': 'now-halo' }));
      s.appendChild(svg('circle', { cx: nx, cy: ny, r: 6, 'class': 'now-dot' }));
      s.appendChild(svgText({ x: nx, y: ny - 18, 'class': 'now-text', 'text-anchor': anchor }, '지금'));
    }
  }

  // ---------- 화면: 최근 7일 (곡선 없는 약) ----------
  function lastSevenDays(drug, now) {
    var today = startOfDay(now), out = [];
    for (var i = 6; i >= 0; i--) {
      var ds = today - i * DAY, de = ds + DAY;
      out.push({
        start: ds,
        taken: state.records.some(function (r) { return r.drug === drug && r.t >= ds && r.t < de; })
      });
    }
    return out;
  }

  function renderStreak(days) {
    var row = $('streakView');
    clear(row);
    days.forEach(function (day, i) {
      var date = new Date(day.start), isToday = i === 6;
      var cell = el('div', 'day' + (day.taken ? ' on' : '') + (isToday ? ' is-today' : ''));
      cell.setAttribute('aria-label', (date.getMonth() + 1) + '월 ' + date.getDate() + '일 ' + (day.taken ? '복용' : '기록 없음'));
      cell.appendChild(el('span', 'day-w', isToday ? '오늘' : WEEK[date.getDay()]));
      var mark = el('span', 'day-mark');
      mark.setAttribute('aria-hidden', 'true');
      if (day.taken) {
        var check = svg('svg', { viewBox: '0 0 18 18' });
        check.appendChild(svg('path', {
          d: 'M4 9.5l3.2 3.2L14 5.8', fill: 'none', stroke: '#FFFFFF',
          'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }));
        mark.appendChild(check);
      }
      cell.appendChild(mark);
      cell.appendChild(el('span', 'day-d', String(date.getDate())));
      row.appendChild(cell);
    });
  }

  // ---------- 화면: 봉투 (상태 · 곡선 · 오늘 복용) ----------
  function setState(key, value, note, empty) {
    $('stateKey').textContent = key;
    var v = $('stateValue');
    v.textContent = value;
    v.classList.toggle('is-empty', !!empty);
    $('stateNote').textContent = note || '';
    $('stateNote').hidden = !note;
  }

  function setLastDose(r, now) {
    var p = $('lastDose');
    clear(p);
    if (!r) return;
    p.appendChild(el('strong', null, (r.t < startOfDay(now) ? '어제 ' : '') + hhmm(r.t)));
    p.appendChild(document.createTextNode(' ' + nameWithDose(r) + ' 복용'));
  }

  function renderEnvelope(now) {
    var key = state.selected, curve = hasCurve(key);
    $('streakView').hidden = curve;

    if (!curve) {
      $('curveView').hidden = true;
      $('modelNote').hidden = true;
      var days = lastSevenDays(key, now);
      var taken = days.filter(function (x) { return x.taken; }).length;
      setState('최근 7일', taken + '일 복용', '매일 꾸준히 먹는 것이 중요한 약');
      renderStreak(days);
      var lastA = latest(function (x) { return x.drug === key; }, now);
      setLastDose(lastA && lastA.t >= now - RECENT_MS ? lastA : null, now);
      return;
    }

    var range = chartRange(now), recs = curveRecords(range.start, range.end);
    var last = recentCurveDose(now);
    $('curveView').hidden = !last;          // 기록이 없으면 빈 그래프 대신 안내만
    $('modelNote').hidden = !last;
    setLastDose(last, now);
    if (!last) {
      setState('오늘', '아직 기록 없음', '먹었다면 아래 버튼으로 기록', true);
      return;
    }
    setState('농도 참고', curveWord(recs, range, now));
    renderChart(now, recs, range);
  }

  // ---------- 화면: 오늘 기록·약 정보·출처·시계 ----------
  function renderLog(now) {
    var list = $('log');
    clear(list);
    var day = startOfDay(now);
    var today = state.records.filter(function (r) { return r.t >= day && r.t < day + DAY; });
    $('logSection').hidden = today.length === 0;   // 오늘 기록이 없으면 구획째 숨김 (위 봉투에 이미 안내)
    today.forEach(function (r) {
      var li = el('li', r.id === justAdded ? 'fresh' : null);
      li.appendChild(el('span', 'log-time', hhmm(r.t)));
      var name = el('span', 'log-name', DRUGS[r.drug].name);
      if (doseText(r)) name.appendChild(el('span', 'log-dose', doseText(r)));
      li.appendChild(name);
      var del = el('button', 'log-del', '삭제');
      del.type = 'button';
      del.setAttribute('aria-label', hhmm(r.t) + ' ' + nameWithDose(r) + ' 기록 삭제');
      del.addEventListener('click', function () { removeRecord(r.id); });
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function renderInfo() {
    var d = DRUGS[state.selected];
    $('infoName').textContent = d.name + ' · ' + d.desc;
    fillFacts($('drugMeta'), [
      ['가장 높을 때', '먹고 ' + d.tmaxText],
      ['절반으로 줄 때', d.halfText]
    ]);
    var note = $('drugNote');
    fillFacts(note, d.note);
    note.hidden = d.note.length === 0;
  }

  function renderSources() {
    var ul = $('sources');
    clear(ul);
    DRUG_ORDER.forEach(function (key) {
      var d = DRUGS[key], li = el('li', 'src');
      li.appendChild(el('strong', 'src-name', d.name));
      li.appendChild(el('span', 'src-vals', '가장 높을 때: 먹고 ' + d.tmaxText));
      li.appendChild(el('span', 'src-vals', '절반으로 줄 때(반감기): ' + d.halfText));
      var a = el('a', 'src-link', d.source.label);
      a.href = d.source.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      li.appendChild(a);
      ul.appendChild(li);
    });
    var note = el('li', 'src src-note');
    note.appendChild(el('span', null, '곡선은 위 수치로 그린 모형 (측정값 아님)'));
    note.appendChild(el('span', null, '상태 표시는 이 앱의 기준: 그날 곡선 최고점의 80% 이상 \'가장 높을 때\', 25% 미만 \'거의 빠짐\''));
    note.appendChild(el('span', null, '비스펜틴 CR: 공식 수치 미확인으로 제외'));
    ul.appendChild(note);
  }

  function renderClock(now) {
    var d = new Date(now);
    $('clock').textContent = hhmm(now);
    $('today').textContent = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + WEEK[d.getDay()] + '요일';
  }

  function render() {
    var now = Date.now();
    renderClock(now);
    renderEnvelope(now);
    renderLog(now);
    renderInfo();
    if (sheetOpen()) renderSheet();
  }

  // ---------- 기록 시트 ----------
  var customTime = false;   // false면 '지금' 시각으로 기록
  var inputPm = false;

  function sheetOpen() { return $('sheet').hasAttribute('open'); }

  function openSheet() {
    customTime = false;
    showTimeError('');
    renderSheet();
    var dlg = $('sheet');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
  function closeSheet() {
    var dlg = $('sheet');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function renderSheet() {
    var d = DRUGS[state.selected], cur = currentDose();

    var drugs = $('drugChips');
    clear(drugs);
    DRUG_ORDER.forEach(function (key) {
      drugs.appendChild(radio('chip', DRUGS[key].name, key === state.selected, function () {
        state.selected = key;
        save(); render(); renderSheet();
      }));
    });

    var doses = $('doseChips');
    clear(doses);
    d.doses.forEach(function (mg) {
      doses.appendChild(radio('chip chip-dose', mg + 'mg', cur === mg, function () {
        if (cur === mg) delete state.dose[state.selected];   // 다시 누르면 선택 해제
        else state.dose[state.selected] = mg;
        save(); renderSheet();
      }));
    });
    // 한 줄에 4개까지, 넘으면 두 줄로 고르게
    var n = d.doses.length;
    doses.style.gridTemplateColumns = 'repeat(' + (n <= 4 ? n : Math.ceil(n / 2)) + ', minmax(0, 1fr))';

    $('whenNow').hidden = customTime;
    $('whenCustom').hidden = !customTime;
    $('nowLabel').textContent = hhmm(Date.now());
    updateSummary();
  }

  function updateSummary() {
    var d = DRUGS[state.selected], cur = currentDose();
    var t = customTime ? peekInputTime() : Date.now();
    $('recordSummary').textContent = d.name + (cur !== null ? ' ' + cur + 'mg' : ' · 용량 미선택') +
      (t !== null ? ' · ' + (customTime ? ampmText(t) : hhmm(t)) : '');
  }

  // ---------- 시각 직접 입력 (오전/오후 + 시·분) ----------
  function setAmPm(pm) {
    inputPm = pm;
    $('ampmAm').setAttribute('aria-pressed', pm ? 'false' : 'true');
    $('ampmPm').setAttribute('aria-pressed', pm ? 'true' : 'false');
  }

  function showTimeError(msg, field) {
    var e = $('timeError');
    e.textContent = msg;
    e.hidden = !msg;
    $('hourInput').classList.toggle('invalid', field === 'h');
    $('minInput').classList.toggle('invalid', field === 'm');
  }

  // 입력값 → 오늘 날짜의 시각(ms). 잘못되면 null (peek는 안내 없이 확인만)
  function parseInputTime(report) {
    var hv = $('hourInput').value.trim(), mv = $('minInput').value.trim();
    var fail = function (msg, f) { if (report) showTimeError(msg, f); return null; };
    if (!/^\d{1,2}$/.test(hv)) return fail('시를 숫자로 입력 (1~12)', 'h');
    if (!/^\d{1,2}$/.test(mv)) return fail('분을 숫자로 입력 (0~59)', 'm');
    var h = parseInt(hv, 10), mi = parseInt(mv, 10);
    if (h < 1 || h > 12) return fail('시는 1~12 사이로 입력', 'h');
    if (mi > 59) return fail('분은 0~59 사이로 입력', 'm');
    if (report) showTimeError('');
    var d = new Date();
    d.setHours((h % 12) + (inputPm ? 12 : 0), mi, 0, 0);
    return d.getTime();
  }
  function readInputTime() { return parseInputTime(true); }
  function peekInputTime() { return parseInputTime(false); }

  function fillInputWithNow() {
    var d = new Date(), h = d.getHours();
    setAmPm(h >= 12);
    $('hourInput').value = String(h % 12 === 0 ? 12 : h % 12);
    $('minInput').value = pad(d.getMinutes());
  }

  function setupSheet() {
    var hour = $('hourInput'), min = $('minInput'), dlg = $('sheet');
    $('openSheet').addEventListener('click', openSheet);
    $('closeSheet').addEventListener('click', closeSheet);
    // 시트 바깥(어두운 부분)을 누르면 닫기
    dlg.addEventListener('click', function (e) {
      if (e.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      if (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right) closeSheet();
    });

    $('changeTime').addEventListener('click', function () {
      customTime = true;
      fillInputWithNow();
      renderSheet();
      hour.focus();
    });
    $('backToNow').addEventListener('click', function () {
      customTime = false;
      showTimeError('');
      renderSheet();
    });

    [hour, min].forEach(function (inp) {
      inp.addEventListener('input', function () {
        var digits = inp.value.replace(/\D/g, '').slice(0, 2);
        if (digits !== inp.value) inp.value = digits;
        showTimeError('');
        updateSummary();
      });
      inp.addEventListener('focus', function () { inp.select(); });
    });
    // 2~9는 한 자리로 끝나 바로 분 칸으로, 1은 10~12일 수 있어 두 자리 입력 후 이동
    hour.addEventListener('input', function () {
      if (hour.value.length === 2 || /^[2-9]$/.test(hour.value)) { min.focus(); min.select(); }
    });
    hour.addEventListener('blur', function () { if (/^0\d$/.test(hour.value)) hour.value = hour.value.slice(1); });
    min.addEventListener('blur', function () { if (/^\d$/.test(min.value)) min.value = '0' + min.value; });
    $('ampmAm').addEventListener('click', function () { setAmPm(false); showTimeError(''); updateSummary(); });
    $('ampmPm').addEventListener('click', function () { setAmPm(true); showTimeError(''); updateSummary(); });

    $('recordBtn').addEventListener('click', function () {
      var t = customTime ? readInputTime() : Date.now();
      if (t === null) return;
      closeSheet();
      addRecord(state.selected, t);
    });
  }

  // ---------- 기타 버튼 ----------
  // 전체 삭제: 실수 방지를 위해 4초 안에 두 번 눌러야 삭제
  function setupClearButton() {
    var btn = $('clearBtn'), msg = $('clearMsg'), timer = null;
    function disarm() { btn.classList.remove('armed'); btn.textContent = '기록 전체 삭제'; }
    btn.addEventListener('click', function () {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = '한 번 더 누르면 삭제';
        msg.hidden = true;
        timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      disarm();
      state.records = [];
      save();
      render();
      msg.textContent = '내 기기의 기록 전체 삭제됨';
      msg.hidden = false;
    });
  }

  // 링크 공유: 공유 시트 → 안 되면 복사 → 안 되면 주소 표시
  function setupShareButton() {
    var msg = $('shareMsg');
    function show(text) { msg.textContent = text; msg.hidden = false; }
    $('shareBtn').addEventListener('click', function () {
      var url = window.location.origin + window.location.pathname;
      if (navigator.share) {
        navigator.share({ title: '복용 기록표', url: url }).catch(function () {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { show('링크 복사됨'); }, function () { show(url); });
      } else {
        show(url);
      }
    });
  }

  // ---------- 시작 ----------
  function init() {
    load();
    save();   // 오래된 기록 정리 후 저장
    setupSheet();
    setupClearButton();
    setupShareButton();
    renderSources();
    render();
    setInterval(render, 30000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { save(); render(); }
    });

    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
