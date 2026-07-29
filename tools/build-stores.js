#!/usr/bin/env node
/*
 * jhf-detail.json を公開用データ stores.json に整形する。
 *
 * 方針
 *  - 載せるのは事実情報のみ（店名・住所・電話・ジャンル・営業時間・公式サイト・出典URL）。
 *    紹介文などの表現物は取り込まない。
 *  - 緯度経度は国土地理院の住所検索API（無償・キー不要）で付与する。
 *  - ジオコーディングに失敗した店は「捨てずに残して flag を立てる」。
 *    黙って消すと「載っていない＝無い」と誤解されるため。
 *  - cert_status は必ず入れる。ここでは全件が認証団体の公開リスト由来なので "certified"。
 *
 * 使い方: node tools/build-stores.js
 * 出力  : data/stores.json
 */
const fs = require('fs');
const path = require('path');

const IN = path.join(__dirname, '..', 'data', 'jhf-detail.json');
const OUT = path.join(__dirname, '..', 'data', 'stores.json');
const CACHE = path.join(__dirname, '..', 'data', 'geocode-cache.json');
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
const UA =
  'Mozilla/5.0 (halal-map dataset builder; contact: 277195349+2026justeco-crypto@users.noreply.github.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 数値文字参照を含む HTML エンティティを戻す */
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 全角英数字・全角ハイフンを半角に寄せる（住所検索の精度対策） */
function toHalf(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－‐‑‒–—―ー]/g, '-')
    .replace(/　/g, ' ');
}

const PREF =
  '北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県';

/** 都道府県が省略されている住所を補う */
function ensurePref(addr) {
  if (new RegExp(`^(${PREF})`).test(addr)) return addr;
  if (/^京都市/.test(addr)) return '京都府' + addr;
  if (/^大阪市/.test(addr)) return '大阪府' + addr;
  if (/^名古屋市/.test(addr)) return '愛知県' + addr;
  if (/^横浜市|^川崎市|^相模原市/.test(addr)) return '神奈川県' + addr;
  if (/^神戸市/.test(addr)) return '兵庫県' + addr;
  if (/^札幌市/.test(addr)) return '北海道' + addr;
  if (/^福岡市|^北九州市/.test(addr)) return '福岡県' + addr;
  // 東京23区の区名で始まるもの
  if (
    /^(千代田区|中央区|港区|新宿区|文京区|台東区|墨田区|江東区|品川区|目黒区|大田区|世田谷区|渋谷区|中野区|杉並区|豊島区|北区|荒川区|板橋区|練馬区|足立区|葛飾区|江戸川区)/.test(
      addr
    )
  ) {
    return '東京都' + addr;
  }
  return addr;
}

/**
 * ジオコーディング用に住所を刈り込む。
 * 番地までで切り、ビル名・階数は落とす（残すとヒットしないため）。
 */
function trimForGeocode(addr) {
  let s = toHalf(addr);
  s = s.replace(/〒\s*\d{3}-?\d{4}\s*/g, '');
  s = ensurePref(s.trim());
  // 「丁目」「-」の続く数字列の末尾までを住所本体とみなす
  const m = s.match(
    new RegExp(`^((?:${PREF})?[^0-9]*?[0-9０-９]+(?:丁目)?(?:[-‐]?[0-9]+)*(?:番地?|号)?)`)
  );
  let core = m ? m[1] : s;
  core = core.replace(/\s+/g, '').replace(/[-]+$/, '');
  return core;
}

/** 住所欄の先頭に店名が前置されている場合に切り出す（なければ空） */
function shopNameFromAddress(addrRaw) {
  const s = decode(addrRaw);
  const m = s.match(/^(.*?)\s*〒\s*\d{3}-?\d{4}/);
  if (m && m[1].trim()) return m[1].trim();
  // 郵便番号が先頭にあるだけの場合は店名なしとみなす（〒を店名にしない）
  const withoutZip = s.replace(/^\s*〒\s*\d{3}-?\d{4}\s*/, '');
  const p = withoutZip.search(new RegExp(`(${PREF})`));
  if (p > 0) return withoutZip.slice(0, p).trim();
  return '';
}

/** 見出しに付く管理番号（FPS-119 など）を落とす */
function cleanCompany(s) {
  return decode(s)
    .replace(/^(?:FPS|JHF|JHFA)[\s-]*\d+[\s-]*/i, '')
    .replace(/^[\s　]*[-‐–—]\s*/, '')
    .trim();
}

/*
 * 出典サイトは見出しを50文字で機械的に切っているため、
 * 語の途中で切れた名前が混ざる（例「…ハラール＆ビーガンラ」）。
 * 勝手に正式名称を推測して補うと誤情報になるので、
 * 切れかけの語だけ落として「…」を付け、正確な名称は出典リンクに委ねる。
 */
const SOURCE_TRUNCATE_AT = 49;
function tidyTruncated(name) {
  if (name.length < SOURCE_TRUNCATE_AT) return { name, truncated: false };
  const cut = name.replace(/\s+\S*$/, '').replace(/[\s*・、,，:：\-–—]+$/, '');
  const base = cut.length >= 8 ? cut : name;
  return { name: base + '…', truncated: true };
}

/**
 * 国土地理院のヒット文字列から、位置の細かさを判定する。
 * 「番地まで一致」と「区の中心にしか落ちていない」を同じ扱いにすると、
 * 実際とかけ離れたピン・距離を正確なものとして見せてしまうため必ず分ける。
 */
function geoPrecision(matched) {
  const s = String(matched || '');
  if (!s) return 'unknown';
  if (/[0-9０-９]+\s*(番地|番|号)/.test(s)) return 'building';
  if (/丁目/.test(s)) return 'block';
  if (/[市区町村]/.test(s)) return 'city';
  if (new RegExp(`^(${PREF})$`).test(s.trim())) return 'pref';
  return 'unknown';
}

/** 都道府県・市区町村をラベル用に抜き出す */
function splitArea(addr) {
  const s = ensurePref(toHalf(addr).replace(/〒\s*\d{3}-?\d{4}\s*/g, '').trim());
  const m = s.match(new RegExp(`^(${PREF})\\s*([^0-9]{1,10}?[市区町村])`));
  if (m) return { pref: m[1], city: m[2] };
  const p = s.match(new RegExp(`^(${PREF})`));
  return { pref: p ? p[1] : '', city: '' };
}

async function geocode(query, cache) {
  if (cache[query] !== undefined) return cache[query];
  const url = GSI + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (Array.isArray(j) && j.length && j[0].geometry) {
      const [lng, lat] = j[0].geometry.coordinates;
      const hit = {
        lat,
        lng,
        matched: (j[0].properties && j[0].properties.title) || '',
      };
      cache[query] = hit;
      return hit;
    }
    cache[query] = null;
    return null;
  } catch (e) {
    console.error(`  geocode error (${query}): ${e.message}`);
    return null;
  }
}

async function main() {
  const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  // 住所のないレコード（お知らせ記事など）は店舗ではないので除く
  const shops = src.filter((r) => !r.error && r.address && r.address.trim());
  const dropped = src.filter((r) => !r.error && (!r.address || !r.address.trim()));
  console.error(`shops: ${shops.length} / dropped(非店舗): ${dropped.length}`);
  dropped.forEach((r) => console.error(`  - dropped: ${decode(r.company)}`));

  const out = [];
  for (let i = 0; i < shops.length; i++) {
    const r = shops[i];
    const company = cleanCompany(r.company);
    // 住所欄に前置された店名を優先。無ければ見出し（事業者名）を店名にする。
    // ※ 画像の title 属性はファイル名のことがあるので使わない。
    const shopFromAddr = shopNameFromAddress(r.address_raw);
    const tidied = tidyTruncated(shopFromAddr || company);
    const name = tidied.name;
    const operator = (shopFromAddr || company) === company ? '' : company;

    const address = decode(ensurePref(toHalf(r.address)));
    const q = trimForGeocode(r.address);
    const hit = await geocode(q, cache);
    if (!hit) await sleep(400);
    else await sleep(300);

    const { pref, city } = splitArea(r.address);

    out.push({
      id: 'jhf-' + r.source_id,
      name,
      // 出典側で名称が途中で切れている。画面では出典リンクを併記して補う。
      name_truncated: tidied.truncated,
      operator,
      genre: decode(r.genre),
      pref,
      city,
      zip: r.zip || '',
      address,
      tel: decode(r.tel),
      hours: decode(r.hours),
      closed: decode(r.closed),
      payment: decode(r.payment),
      web: decode(r.web),
      lat: hit ? hit.lat : null,
      lng: hit ? hit.lng : null,
      geo_query: q,
      geo_matched: hit ? hit.matched : '',
      // 位置が取れなかった店は落とさずフラグを立てる。地図ボタンは住所文字列で開く。
      geo_ok: !!hit,
      // building/block = 距離を出してよい。city/pref = 中心にしか落ちていないので距離は参考値。
      geo_precision: hit ? geoPrecision(hit.matched) : 'none',
      cert_status: 'certified',
      cert_org: r.source_org,
      source_url: r.source_url,
    });
    const prec = hit ? geoPrecision(hit.matched) : 'none';
    const mark = prec === 'building' || prec === 'block' ? ' ' : '★';
    console.error(
      `  [${i + 1}/${shops.length}]${mark}[${prec}] ${name} -> ${hit ? hit.matched : '位置不明'}`
    );
  }

  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf8');

  const payload = {
    generated_at: new Date().toISOString(),
    note:
      'ハラール認証店の一覧。事実情報のみを掲載し、各件に出典URLを付す。' +
      '掲載内容は変わることがあるため、最終確認は必ず店舗へ。',
    sources: [
      {
        org: '一般社団法人ジャパン・ハラール・ファンデーション',
        url: 'https://japanhalal.or.jp/shop',
        cert_status: 'certified',
      },
    ],
    count: out.length,
    geo_failed: out.filter((s) => !s.geo_ok).length,
    geo_approx: out.filter((s) => s.geo_ok && !['building', 'block'].includes(s.geo_precision))
      .length,
    stores: out,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  // file:// で開いても動くように JS 版も出す（fetch は file:// だと CORS で失敗するため）
  fs.writeFileSync(
    OUT.replace(/\.json$/, '.js'),
    'window.HALAL_DATA = ' + JSON.stringify(payload) + ';\n',
    'utf8'
  );
  console.error(
    `\nwrote ${OUT} (${out.length} stores / 位置不明 ${payload.geo_failed} 件 / おおよその位置 ${payload.geo_approx} 件)`
  );
}

main();
