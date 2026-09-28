import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync('raw/list.pdf')) }).promise;
let out = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  // group by y
  const rows = new Map();
  for (const it of tc.items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    let key = [...rows.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x, s: it.str });
  }
  const ys = [...rows.keys()].sort((a, b) => b - a);
  for (const y of ys) out.push(`P${p}\t` + rows.get(y).sort((a, b) => a.x - b.x).map(o => `${Math.round(o.x)}:${o.s}`).join(' | '));
}
fs.writeFileSync('raw/list.txt', out.join('\n'));
console.log(doc.numPages, out.length);
