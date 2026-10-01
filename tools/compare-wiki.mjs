// Compare our per-municipality code assignment with the 市外局番 written in
// each municipality's Japanese Wikipedia article.
import fs from 'fs';
const wiki = JSON.parse(fs.readFileSync('out/wiki-codes.json', 'utf8'));
const a3 = JSON.parse(fs.readFileSync('out/assign3.json', 'utf8'));
const a4 = JSON.parse(fs.readFileSync('out/assign4.json', 'utf8'));
const muni = JSON.parse(fs.readFileSync('raw/muni.topo.json', 'utf8'));
const names = {};
for (const g of Object.values(muni.objects)[0].geometries) {
  const p = g.properties;
  if (p.N03_007) names[p.N03_007] = p.N03_001 + (p.N03_003 || '') + (p.N03_004 || '');
}
// a designated-city ward article rarely states the code: fall back to the city article
const cityOf = {};
for (const [code, w] of Object.entries(wiki)) { const m = w.title.match(/^(.+市)$/); if (m) cityOf[m[1]] = w; }

const res = { checked: 0, ok3: 0, ok4: 0, noData: [], ng3: [], ng4: [] };
for (const code of Object.keys(names)) {
  if (!a4[code]) continue; // northern territories
  let w = wiki[code];
  if (w && !w.codes.length) {
    const city = (w.title.match(/\((.+市)\)$/) || [])[1];
    if (city && cityOf[city] && cityOf[city].codes.length) w = cityOf[city];
  }
  const codes = (w && w.codes) || [];
  if (!codes.length) { res.noData.push(`${code} ${names[code]}`); continue; }
  res.checked++;
  const w3 = new Set(codes.map((c) => c.slice(0, 3)));
  const w4 = new Set(codes.map((c) => c.slice(0, 4)));
  const line = `${names[code]}: ours=${a3[code]}/${a4[code]} wiki=${codes.join(',')}  «${(w.lines[0] || '').slice(0, 110)}»`;
  if (w3.has(a3[code])) res.ok3++; else res.ng3.push(line);
  if (w4.has(a4[code])) res.ok4++; else res.ng4.push(line);
}
console.log(`checked ${res.checked}, no wiki data ${res.noData.length}`);
console.log(`3-digit match ${res.ok3}/${res.checked}, 4-digit match ${res.ok4}/${res.checked}`);
fs.writeFileSync('out/compare.json', JSON.stringify(res, null, 1));
