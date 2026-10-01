// Parse MIC area-code list (raw/list.txt) and assign each N03 unit to a 0AB code.
import fs from 'fs';

// ---- 1. entries from PDF rows ----
const norm = t => t.replace(/ヶ/g, 'ケ').replace(/檮/g, '梼').replace(/篠山市/g, '丹波篠山市').replace(/丹波丹波/g, '丹波');
const rows = norm(fs.readFileSync('raw/list.txt', 'utf8')).split('\n').map(l => l.split('\t')[1]);
const entries = [];
for (const r of rows) {
  const cells = r.split(' | ').map(c => { const i = c.indexOf(':'); return { x: +c.slice(0, i), s: c.slice(i + 1) }; });
  const idCell = cells.find(c => c.x < 115 && /^\d+(-\d+)?$/.test(c.s));
  const text = cells.filter(c => c.x >= 115 && c.x < 420).map(c => c.s).join('');
  const code = cells.find(c => c.x >= 420 && c.x < 460 && /^\d+$/.test(c.s));
  if (idCell) entries.push({ id: idCell.s, text, code: code?.s });
  else if (entries.length && text && !/番号区画|市外局番の一覧|現在/.test(text)) {
    entries.at(-1).text += text;
    if (code && !entries.at(-1).code) entries.at(-1).code = code.s;
  }
}
const noCode = entries.filter(e => !e.code);
if (noCode.length) console.log('NO CODE:', noCode);
// LEVEL = number of leading digits (incl. the 0) to group by: 3 -> 045, 0123 -> 012; 4 -> 0123, 01267 -> 0126
const LEVEL = +(process.argv[2] || 3);
const to0AB = c => '0' + c.slice(0, LEVEL - 1);
entries.forEach(e => e.ab = to0AB(e.code));

// ---- 2. units ----
const topo = JSON.parse(fs.readFileSync('raw/muni.topo.json', 'utf8'));
const geoms = topo.objects[Object.keys(topo.objects)[0]].geometries;
const units = new Map(); // code -> unit
for (const g of geoms) {
  const p = g.properties;
  if (!p.N03_007) continue;
  if (!units.has(p.N03_007)) units.set(p.N03_007, {
    code: p.N03_007, pref: p.N03_001, grp: norm((p.N03_003 || '').replace(/.*支庁$/, '')), name: norm(p.N03_004 || ''),
    full: norm((p.N03_003 || '').replace(/.*支庁$/, '') + (p.N03_004 || '')), claims: [],
  });
}
const U = [...units.values()];
const PREFS = [...new Set(U.map(u => u.pref))];

// ---- 3. parsing helpers ----
function splitTop(s, seps = ['、']) {
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '（') d++; if (ch === '）') d--;
    if (d === 0 && seps.includes(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map(t => t.trim()).filter(Boolean);
}
function baseQual(tok) {
  const i = tok.indexOf('（');
  if (i < 0) return [tok, null];
  return [tok.slice(0, i), tok.slice(i + 1, tok.lastIndexOf('）'))];
}
const claim = (u, e, strength, why) => u.claims.push({ ab: e.ab, id: e.id, strength, why });
const unmatched = [];

function groupUnits(pref, base) {
  if (base === '23区') return U.filter(u => u.pref === '東京都' && !u.grp && /区$/.test(u.name));
  const exact = U.filter(u => u.pref === pref && u.full === base);
  if (exact.length) return exact;
  const byGrp = U.filter(u => u.pref === pref && u.grp === base);
  if (byGrp.length) return byGrp;
  // designated city ward written as 市+区 e.g. 相模原市緑区 handled by exact
  return [];
}

function handleToken(pref, tok, e) {
  const [base, qual] = baseQual(tok);
  let us = groupUnits(pref, base);
  if (us.length) {
    const isGroup = us.length > 1 || us[0].full !== base;
    if (!qual) return us.forEach(u => claim(u, e, 3, 'plain'));
    if (/を除く。?$/.test(qual)) {
      const ex = splitTop(qual.replace(/を除く。?$/, '').replace(/及び|並びに/g, '、'));
      return us.forEach(u => {
        if (isGroup && ex.some(t => t.startsWith(u.name))) return; // excluded (maybe partially) member
        claim(u, e, 2, 'except');
      });
    }
    if (/に限る。?$/.test(qual)) {
      if (isGroup) {
        // members listed in the qualifier
        const inner = splitTop(qual.replace(/に限る。?$/, ''), ['、']).flatMap(t => splitTop(t.replace(/及び|並びに/g, '、')));
        let any = false;
        for (const u of us) {
          const hit = inner.find(t => t.startsWith(u.name));
          if (!hit) continue; any = true;
          const [b, q] = baseQual(hit);
          if (b === u.name && (!q || /を除く/.test(q))) claim(u, e, 2, 'limited-member');
          else claim(u, e, 1, 'limited-member-partial');
        }
        if (!any) us.forEach(u => claim(u, e, 1, 'limited-group?'));
        return;
      }
      return us.forEach(u => claim(u, e, 1, 'limited-part'));
    }
    return us.forEach(u => claim(u, e, 2, 'qual?'));
  }
  // partial: longest unit/group name that prefixes base
  const cands = U.filter(u => u.pref === pref && ((u.full && base.startsWith(u.full)) || (u.grp && base.startsWith(u.grp))));
  if (cands.length) {
    const best = Math.max(...cands.map(u => base.startsWith(u.full) ? u.full.length : u.grp.length));
    cands.filter(u => (base.startsWith(u.full) ? u.full.length : u.grp.length) === best).forEach(u => claim(u, e, 1, 'sub-area'));
    return;
  }
  unmatched.push(`${e.id}(${e.ab}) ${pref} ${tok}`);
}

for (const e of entries) {
  let pref = null;
  for (let tok of splitTop(e.text)) {
    const p = PREFS.find(p => tok.startsWith(p));
    if (p) { pref = p; tok = tok.slice(p.length); }
    handleToken(pref, tok, e);
  }
}

// ---- 4. resolve ----
const assign = {}; const report = { unassigned: [], ties: [] };
for (const u of U) {
  if (!u.claims.length) { report.unassigned.push(`${u.code} ${u.pref}${u.full}`); continue; }
  const m = Math.max(...u.claims.map(c => c.strength));
  const top = u.claims.filter(c => c.strength === m);
  const abs = [...new Set(top.map(c => c.ab))];
  if (abs.length > 1) report.ties.push(`${u.pref}${u.full}: ` + top.map(c => `${c.ab}#${c.id}(${c.why})`).join(' '));
  assign[u.code] = abs[0];
}
console.log('entries', entries.length, 'units', U.length, 'assigned', Object.keys(assign).length);
console.log('UNMATCHED', unmatched.length, unmatched.slice(0, 80));
console.log('UNASSIGNED', report.unassigned);
console.log('TIES', report.ties);
const lost = [...new Set(entries.map(e => e.ab))].filter(ab => !Object.values(assign).includes(ab));
console.log('CODES WITHOUT ANY WHOLE UNIT', lost.length, lost.join(' '));
fs.writeFileSync(`out/assign${LEVEL}.json`, JSON.stringify(assign));
fs.writeFileSync(`out/assign${LEVEL}.csv`, 'N03_007,ab\n' + Object.entries(assign).map(([k, v]) => k + ',' + v).join('\n'));
fs.writeFileSync(`out/entries${LEVEL}.json`, JSON.stringify(entries, null, 1));
