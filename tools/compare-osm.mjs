// Compare our per-municipality code assignment with town-hall phone numbers in OpenStreetMap.
import fs from 'fs';
import * as topojson from 'topojson-client';
import * as turf from '@turf/turf';

const a3 = JSON.parse(fs.readFileSync('out/assign3.json', 'utf8'));
const a4 = JSON.parse(fs.readFileSync('out/assign4.json', 'utf8'));
const muni = JSON.parse(fs.readFileSync('raw/muni.topo.json', 'utf8'));
const feats = topojson.feature(muni, Object.values(muni.objects)[0]).features.filter((f) => f.properties.N03_007);
const osm = JSON.parse(fs.readFileSync('raw/osm-townhalls.json', 'utf8')).elements;

const rows = [];
for (const e of osm) {
  const raw = e.tags.phone || e.tags['contact:phone'];
  const phone = raw.split(';')[0].trim();
  let national;
  if (/^\+81/.test(phone)) national = '0' + phone.replace(/^\+81[\s-]*/, '');
  else if (/^0/.test(phone)) national = phone;
  else continue; // not a Japanese number
  // area code = first group when the number is written with separators
  const groups = national.split(/[\s\-‐ー－()（）]+/).filter(Boolean);
  const digits = national.replace(/\D/g, '');
  if (digits.length !== 10 || /^0[5789]0|^0120/.test(digits)) continue; // only fixed-line numbers
  const area = groups.length >= 3 ? groups[0] : null;
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  const pt = turf.point([lon, lat]);
  const f = feats.find((f) => turf.booleanPointInPolygon(pt, f));
  if (!f) continue; // outside Japan's municipalities (e.g. Korea)
  const p = f.properties, code = p.N03_007;
  if (!a4[code]) continue;
  rows.push({ code, muni: p.N03_001 + (p.N03_003 || '') + (p.N03_004 || ''), name: e.tags.name || '', phone, digits, area });
}

const ng = [];
const units = new Set();
for (const r of rows) {
  units.add(r.code);
  // exact area code when known, otherwise the number must at least start with our code
  const ok3 = r.area ? r.area.slice(0, 3) === a3[r.code].slice(0, 3) || r.area === a3[r.code] : r.digits.startsWith(a3[r.code]);
  const ok4 = r.area ? r.area.slice(0, 4) === a4[r.code] || r.area === a4[r.code] : r.digits.startsWith(a4[r.code]);
  if (!ok3 || !ok4) ng.push(`${r.muni} [${r.name}] ${r.phone}  ours=${a3[r.code]}/${a4[r.code]}${ok3 ? '' : ' ✗3'}${ok4 ? '' : ' ✗4'}`);
}
console.log(`town halls in Japan with fixed-line phone: ${rows.length} (municipalities covered: ${units.size})`);
console.log(`with explicit area-code separator: ${rows.filter((r) => r.area).length}`);
console.log(`mismatches: ${ng.length}`);
ng.forEach((l) => console.log('  ' + l));
fs.writeFileSync('out/compare-osm.json', JSON.stringify({ rows, ng }, null, 1));
