#!/usr/bin/env node
/*
 * ジャパン・ハラール・ファンデーション（JHF）の公開「認証実績」ページから
 * ハラール認証を取得した店舗の情報を取得する。
 *
 * - 取得するのは事実情報（店名・住所・電話・ジャンル・認証品目・公式サイト）のみ。
 * - 出典URLを1件ずつ records に残す（後で画面に必ず表示するため）。
 * - 画像・説明文などの表現物は取得しない。
 *
 * 使い方: node tools/scrape-jhf.js
 * 出力  : data/jhf-detail.json
 */
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '..', 'data', 'raw-jhf.json');
const OUT = path.join(__dirname, '..', 'data', 'jhf-detail.json');
const UA =
  'Mozilla/5.0 (halal-map dataset builder; contact: 277195349+2026justeco-crypto@users.noreply.github.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全角スペース・連続空白をまとめる
const norm = (s) =>
  String(s || '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stripTags = (s) => norm(String(s || '').replace(/<[^>]*>/g, ''));

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");

/** <th>ラベル</th><td>値</td> を拾う */
function pickCell(html, label) {
  const re = new RegExp(
    `<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(stripTags(m[1])) : '';
}

/** <th>ラベル</th><td>…<a href="X">…  の href を拾う */
function pickCellHref(html, label) {
  const re = new RegExp(
    `<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>[\\s\\S]*?<a[^>]*href="([^"]*)"`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1].trim()) : '';
}

/** 住所セルは「店舗名 〒000-0000 都道府県…」が連結されていることがある */
function splitAddress(cell) {
  const s = norm(cell);
  const m = s.match(/^(.*?)\s*〒\s*(\d{3}-?\d{4})\s*(.+)$/);
  if (m) {
    return { shopName: norm(m[1]), zip: m[2], address: norm(m[3]) };
  }
  // 〒なし。都道府県から始まる位置を探す
  const p = s.search(
    /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|京都市|大阪府|大阪市|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/
  );
  if (p > 0) return { shopName: norm(s.slice(0, p)), zip: '', address: norm(s.slice(p)) };
  if (p === 0) return { shopName: '', zip: '', address: s };
  return { shopName: '', zip: '', address: s };
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const targets = raw.filter((r) => r.href && /\/results\/\d+\.html/.test(r.href));
  console.error(`detail pages: ${targets.length}`);

  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      const html = await fetchHtml(t.href);

      // 事業者名（本文の h1。ヘッダーのロゴ h1 は class を持つので除外）
      const h1s = [...html.matchAll(/<h1(?![^>]*class=)[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
        decodeEntities(stripTags(m[1]))
      );
      const company = h1s.find((s) => s.length > 0) || decodeEntities(norm(t.company)).replace(/…$/, '');

      // 認証品目（<table> の直前あたりの <p>）
      let certItems = '';
      const beforeTable = html.split(/<table/i)[0] || '';
      const ps = [...beforeTable.matchAll(/<p(?![^>]*text_center)[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => decodeEntities(stripTags(m[1])))
        .filter(Boolean);
      if (ps.length) certItems = ps[ps.length - 1];

      const addrCell = pickCell(html, '住所');
      const { shopName, zip, address } = splitAddress(addrCell);

      out.push({
        source_id: t.href.match(/(\d+)\.html/)[1],
        source_url: t.href,
        source_org: '一般社団法人ジャパン・ハラール・ファンデーション',
        company,
        shop_name: shopName || t.imgTitle || company,
        genre: pickCell(html, 'ジャンル') || t.category,
        cert_items: certItems,
        zip,
        address,
        address_raw: addrCell,
        tel: pickCell(html, '電話番号'),
        closed: pickCell(html, '休業日'),
        hours: pickCell(html, '営業時間'),
        reservation: pickCell(html, '予約'),
        payment: pickCell(html, 'カード利用'),
        web: pickCellHref(html, 'WEB') || pickCell(html, 'WEB'),
        facebook: pickCellHref(html, 'FacebookPage'),
      });
      console.error(`  [${i + 1}/${targets.length}] ${shopName || company}`);
    } catch (e) {
      console.error(`  [${i + 1}/${targets.length}] FAILED ${t.href}: ${e.message}`);
      out.push({ source_url: t.href, error: String(e.message) });
    }
    await sleep(700); // 相手サーバーに負荷をかけない
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.error(`\nwrote ${OUT} (${out.length} records, ${out.filter((r) => r.error).length} errors)`);
}

main();
