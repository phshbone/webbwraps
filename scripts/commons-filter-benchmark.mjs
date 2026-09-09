import fs from 'node:fs/promises';

const API = 'https://commons.wikimedia.org/w/api.php';
const threshold = 55;

const cases = [
  ['Honda','Civic'], ['Toyota','RAV4'], ['Ford','F-150'],
  ['Chevrolet','Suburban'], ['Dodge','Charger']
].flatMap(([make,model]) =>
  [2022,2023,2024,2025,2026].map(year => ({ make, model, year }))
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripHtml(value='') {
  return String(value)
    .replace(/<[^>]*>/g,' ')
    .replace(/&nbsp;/g,' ')
    .replace(/&amp;/g,'&')
    .replace(/\s+/g,' ')
    .trim();
}

function norm(value='') {
  return stripHtml(value)
    .toLowerCase()
    .replace(/[_-]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function hasExactModelYear(page, make, model, year) {
  const info = page.imageinfo?.[0] || {};
  const meta = info.extmetadata || {};
  const title = norm((page.title || '').replace(/^File:/i,''));
  const description = norm(meta.ImageDescription?.value);
  const prefix = norm(year + ' ' + make + ' ' + model);
  const suffix = norm(make + ' ' + model + ' ' + year);

  // Strongest signal: Commons filename starts with the model year + make + model.
  if (title.startsWith(prefix + ' ') || title === prefix) return true;

  // Secondary signal: description explicitly attaches the year to the make/model.
  if (description.includes(prefix) || description.includes(suffix)) return true;

  return false;
}

function score(page, make, model, year) {
  const info = page.imageinfo?.[0] || {};
  const meta = info.extmetadata || {};
  const categories = (page.categories || []).map(c => c.title || '').join(' ');
  const text = [
    page.title || '',
    stripHtml(meta.ImageDescription?.value),
    stripHtml(meta.ObjectName?.value),
    categories
  ].join(' ').toLowerCase();

  const makeTokens = make.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const modelTokens = model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  if (!hasExactModelYear(page, make, model, year)) return -999;
  if (!makeTokens.every(t => text.includes(t))) return -999;
  if (!modelTokens.every(t => text.includes(t))) return -999;

  let s = 40;

  for (const [term,pts] of [
    ['front left',18], ['front right',18], ['front-left',18], ['front-right',18],
    ['three-quarter',16], ['three quarter',16], ['3/4',16],
    ['side view',12], ['profile',10], ['front view',8], ['front',5]
  ]) if (text.includes(term)) s += pts;

  for (const [term,pts] of [
    ['interior',-35], ['dashboard',-35], ['engine',-30],
    ['rear view',-18], ['rear',-10],
    ['auto show',-20], ['motor show',-20], ['salon',-12], ['museum',-16],
    ['rain',-20], ['wet',-10], ['snow',-18],
    ['gas station',-28], ['petrol station',-28], ['fuel station',-28],
    ['refueling',-28], ['refuelling',-28],
    ['traffic',-15], ['street scene',-12],
    ['damaged',-30], ['wreck',-35], ['police',-12], ['taxi',-12]
  ]) if (text.includes(term)) s += pts;

  const maxDim = Math.max(info.width || 0, info.height || 0);
  if (maxDim >= 5000) s += 12;
  else if (maxDim >= 3000) s += 9;
  else if (maxDim >= 1800) s += 5;
  else if (maxDim < 1200) s -= 20;

  if (/quality images/i.test(categories)) s += 12;
  if (/featured pictures/i.test(categories)) s += 10;
  if (/valued images/i.test(categories)) s += 7;

  return s;
}

async function fetchJson(url) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(url, {
      headers: { 'User-Agent': 'WebbWrapsBenchmark/1.0 (GitHub Actions)' }
    });
    if (response.status !== 429) return response;
    await sleep(5000 * (attempt + 1));
  }
  return response;
}

async function searchPages(c, search) {
  const p = new URLSearchParams({
    action:'query',
    format:'json',
    origin:'*',
    generator:'search',
    gsrnamespace:'6',
    gsrsearch: search,
    gsrlimit:'20',
    prop:'imageinfo|categories',
    iiprop:'url|size|extmetadata',
    iiurlwidth:'1400',
    iiextmetadatafilter:'ImageDescription|ObjectName|Artist|Credit|LicenseShortName|LicenseUrl',
    cllimit:'max',
    maxlag:'5'
  });

  const r = await fetchJson(API + '?' + p.toString());
  if (!r.ok) return { error: 'HTTP ' + r.status, pages: [] };
  const data = await r.json();
  return { pages: Object.values(data.query?.pages || []) };
}

async function runCase(c) {
  const exactPhrase = c.year + ' ' + c.make + ' ' + c.model;
  const primary = await searchPages(c, 'intitle:"' + exactPhrase + '"');
  if (primary.error && primary.error !== 'HTTP 429') {
    return { ...c, status:'ERROR', reason:primary.error };
  }

  await sleep(900);
  const secondary = await searchPages(c, exactPhrase);
  if (secondary.error && primary.pages.length === 0) {
    return { ...c, status:'ERROR', reason:secondary.error };
  }

  const byId = new Map();
  for (const page of [...primary.pages, ...secondary.pages]) byId.set(page.pageid, page);

  const ranked = [...byId.values()]
    .map(page => ({ page, score: score(page, c.make, c.model, c.year) }))
    .filter(x => x.score > -999)
    .sort((a,b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    return { ...c, status:'REJECT', score:null, reason:'no exact-year/model candidate' };
  }

  const status = best.score >= 70 ? 'GOOD' :
                 best.score >= threshold ? 'MARGINAL' : 'REJECT';

  return {
    ...c,
    status,
    score: best.score,
    title: best.page.title,
    image: best.page.imageinfo?.[0]?.thumburl || best.page.imageinfo?.[0]?.url || '',
    page: best.page.imageinfo?.[0]?.descriptionurl || '',
    candidates: ranked.length
  };
}

const results = [];
for (const c of cases) {
  const result = await runCase(c);
  results.push(result);
  console.log(JSON.stringify(result));
  await sleep(1800);
}

const summary = results.reduce((acc,r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});

console.log('SUMMARY', JSON.stringify(summary));
await fs.writeFile(
  'commons-filter-benchmark.json',
  JSON.stringify({ threshold, summary, results }, null, 2)
);
