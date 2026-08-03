#!/usr/bin/env node
/*
 * OpenStreetMap から日本国内の halal 関連 POI を取得する。
 *
 * なぜ足すか
 *  - JHF の「認証実績」は認証団体の実績一覧であって店舗ディレクトリではない。
 *    51件・6都府県しかないため「近くの店を探す」用途では大半が空振りする。
 *  - OSM は全国を覆っており、ライセンス上も再利用できる。
 *
 * ただし OSM のタグは誰でも書ける。店自身の申告でも認証団体の公表でもないので、
 * cert_status は certified/self/friendly のどれでもなく "osm"（地図データ）を新設して分ける。
 * 確からしさの区分を混ぜないことが、このサイトの安全設計の核なので崩さない。
 *
 * ライセンス: ODbL 1.0 / © OpenStreetMap contributors
 *   → 表示義務があるので data/stores.json の sources と画面フッターに必ず出す。
 *
 * 使い方: node tools/fetch-osm.js
 * 出力  : data/raw-osm.json
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'raw-osm.json');
const UA =
  'halal-map dataset builder (contact: 277195349+2026justeco-crypto@users.noreply.github.com)';

// 混雑時に備えて複数の公開インスタンスを順に試す
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/*
 * diet:halal は yes / only / no / limited などを取る。
 *  - only    = 提供するものが全てハラール
 *  - yes     = ハラールのものを提供している
 *  - limited = 一部のみ
 * no は「提供していない」という情報なので取り込まない（載せると逆の意味になる）。
 */
const QUERY = `
[out:json][timeout:300];
area["ISO3166-1"="JP"][admin_level=2]->.jp;
(
  nwr["diet:halal"~"^(yes|only|limited)$"](area.jp);
  nwr["halal"~"^(yes|only|limited)$"](area.jp);
  nwr["cuisine"~"halal",i](area.jp);
);
out center tags;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(endpoint) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'data=' + encodeURIComponent(QUERY),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  return res.json();
}

async function main() {
  let json = null;
  let lastErr = null;
  for (const ep of ENDPOINTS) {
    try {
      console.error(`query -> ${ep}`);
      json = await run(ep);
      break;
    } catch (e) {
      lastErr = e;
      console.error(`  失敗: ${e.message}`);
      await sleep(3000);
    }
  }
  if (!json) throw lastErr || new Error('全エンドポイントで失敗');

  const els = json.elements || [];
  console.error(`取得: ${els.length} 件`);

  // タグ別の内訳を出す（あとで区分の妥当性を見直すため）
  const byDiet = {};
  els.forEach((e) => {
    const t = e.tags || {};
    const v = t['diet:halal'] || (t.halal ? 'halal=' + t.halal : '') || (t.cuisine ? 'cuisine' : '?');
    byDiet[v] = (byDiet[v] || 0) + 1;
  });
  console.error('内訳:', JSON.stringify(byDiet));
  const named = els.filter((e) => (e.tags || {}).name).length;
  console.error(`名前あり: ${named} / 名前なし: ${els.length - named}`);

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        license: 'ODbL 1.0',
        attribution: '© OpenStreetMap contributors',
        query: QUERY.trim(),
        count: els.length,
        elements: els,
      },
      null,
      2
    ),
    'utf8'
  );
  console.error(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
