// Cross-check helper: read each municipality's Japanese Wikipedia article and
// collect the 市外局番 it mentions (an independent source for the area code).
import fs from 'fs';
const UA = 'area-code-quiz-check/1.0 (https://area-code.saitho.jp)';

// N03 municipality code -> jawiki article title, via Wikidata (P429 = 全国地方公共団体コード)
const sparql = 'SELECT ?lg ?title WHERE { ?item wdt:P429 ?lg . ?a schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?title . }';
const wd = await fetch('https://query.wikidata.org/sparql?' + new URLSearchParams({ query: sparql }), {
  headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
}).then((r) => r.json());
const muni = JSON.parse(fs.readFileSync('raw/muni.topo.json', 'utf8'));
const unitCodes = new Set(Object.values(muni.objects)[0].geometries.map((g) => g.properties.N03_007).filter(Boolean));
const titles = {};
for (const r of wd.results.bindings) {
  const code = r.lg.value.slice(0, 5); // drop the check digit
  if (unitCodes.has(code)) titles[code] = r.title.value;
}
const entries = Object.entries(titles);
const out = {};
for (let i = 0; i < entries.length; i += 50) {
  const batch = entries.slice(i, i + 50);
  const url = 'https://ja.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
    redirects: '1', format: 'json', formatversion: '2', titles: batch.map(([, t]) => t).join('|'),
  });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await res.json();
  const norm = new Map();
  for (const n of [...(j.query.normalized || []), ...(j.query.redirects || [])]) norm.set(n.from, n.to);
  const byTitle = new Map(j.query.pages.map((p) => [p.title, p.revisions?.[0]?.slots?.main?.content || '']));
  for (const [code, t] of batch) {
    let title = t;
    while (norm.has(title)) title = norm.get(title);
    const text = byTitle.get(title) || '';
    // lines that mention 市外局番 (infobox 特記事項 and 電話 sections), with the codes in them
    const lines = text.split('\n').filter((l) => l.includes('市外局番'));
    // drop link targets like [[foo|bar]] -> bar, then pick 0-prefixed codes (not parts of longer numbers)
    const codes = [...new Set(lines.flatMap((l) => l.replace(/\[\[[^\]|]*\|/g, '').match(/(?<![\d-])0\d{1,4}(?!\d)/g) || []))];
    out[code] = { title, codes, lines: lines.slice(0, 4).map((l) => l.slice(0, 300)) };
  }
  process.stdout.write(`${Math.min(i + 50, entries.length)} `);
  await new Promise((r) => setTimeout(r, 400));
}
fs.writeFileSync('out/wiki-codes.json', JSON.stringify(out, null, 1));
const got = Object.values(out).filter((o) => o.codes.length).length;
console.log(`\nwith 市外局番 mention: ${got} / ${entries.length}`);
