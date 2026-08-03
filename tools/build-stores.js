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
const IN_OSM = path.join(__dirname, '..', 'data', 'raw-osm.json');
const OUT = path.join(__dirname, '..', 'data', 'stores.json');
const CACHE = path.join(__dirname, '..', 'data', 'geocode-cache.json');
const RCACHE = path.join(__dirname, '..', 'data', 'revgeo-cache.json');
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';
const GSI_REV = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const GSI_MUNI = 'https://maps.gsi.go.jp/js/muni.js';
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

/* ---------------- ここから OpenStreetMap 分 ---------------- */

/*
 * OSM のタグは誰でも書ける。店自身の申告でも認証団体の公表でもないので、
 * certified / self / friendly のどれにも入れず "osm"（地図データ）で分ける。
 * 「誰が言っているか」で区分を切るのがこのサイトの安全設計なので、そこは崩さない。
 * どの程度ハラールかはカードの文言で別に伝える。
 */
const OSM_HALAL_TEXT = {
  only: '出すものは全てハラール、と地図データに記載',
  yes: 'ハラールのものを出している、と地図データに記載',
  limited: '一部のみハラール、と地図データに記載',
};

/** OSM のタグから、画面に出すジャンル名を作る */
const CUISINE_JA = {
  kebab: 'ケバブ',
  turkish: 'トルコ料理',
  indian: 'インド料理',
  pakistani: 'パキスタン料理',
  bangladeshi: 'バングラデシュ料理',
  indonesian: 'インドネシア料理',
  malaysian: 'マレーシア料理',
  arab: 'アラブ料理',
  curry: 'カレー',
  ramen: 'ラーメン',
  japanese: '日本料理',
  chinese: '中華料理',
  asian: 'アジア料理',
  uyghur: 'ウイグル料理',
  egyptian: 'エジプト料理',
  moroccan: 'モロッコ料理',
  persian: 'ペルシャ料理',
  nepalese: 'ネパール料理',
  sri_lankan: 'スリランカ料理',
  pizza: 'ピザ',
  burger: 'ハンバーガー',
  chicken: 'チキン',
  halal: 'ハラール',
  regional: '郷土料理',
  international: '各国料理',
  thai: 'タイ料理',
  vietnamese: 'ベトナム料理',
  korean: '韓国料理',
  american: 'アメリカ料理',
  mediterranean: '地中海料理',
  middle_eastern: '中東料理',
  andhra_pradesh: '南インド料理',
  okonomiyaki: 'お好み焼き',
  noodle: '麺類',
  buffet: 'ビュッフェ',
  steak_house: 'ステーキ',
  barbecue: 'バーベキュー',
  sandwich: 'サンドイッチ',
  coffee_shop: 'コーヒー',
  dessert: 'デザート',
  african: 'アフリカ料理',
  afghan: 'アフガン料理',
  lebanese: 'レバノン料理',
  syrian: 'シリア料理',
  bengali: 'ベンガル料理',
  fried_chicken: 'フライドチキン',
};
const AMENITY_JA = {
  restaurant: 'レストラン',
  fast_food: 'ファストフード',
  cafe: 'カフェ',
  bar: 'バー',
  pub: 'パブ',
  food_court: 'フードコート',
  ice_cream: 'アイスクリーム',
};
const SHOP_JA = {
  supermarket: 'スーパー',
  convenience: 'コンビニ',
  butcher: '精肉店',
  bakery: 'パン屋',
  greengrocer: '八百屋',
  deli: '惣菜店',
  grocery: '食料品店',
  general: '雑貨店',
  confectionery: '菓子店',
  seafood: '鮮魚店',
  frozen_food: '冷凍食品店',
  food: '食料品店',
  alcohol: '酒店',
  spices: 'スパイス店',
};

/*
 * OSM の opening_hours は機械可読の書式（"Mo-Tu,Th-Su 11:00-20:00; We off"）。
 * そのまま出すと読めないので曜日と休みだけ日本語にする。
 * 解釈しきれない書式は無理に整形せず、時刻部分がそのまま読める形で残す。
 */
const OSM_DAY = { Mo: '月', Tu: '火', We: '水', Th: '木', Fr: '金', Sa: '土', Su: '日', PH: '祝' };
function osmHours(s) {
  let t = decode(s);
  if (!t) return '';
  if (/^24\/7$/.test(t)) return '24時間';
  const days = Object.keys(OSM_DAY).join('|');
  t = t.replace(new RegExp(`\\b(${days})-(${days})\\b`, 'g'), (_, a, b) => OSM_DAY[a] + '〜' + OSM_DAY[b]);
  t = t.replace(new RegExp(`\\b(${days})\\b`, 'g'), (_, a) => OSM_DAY[a]);
  t = t.replace(/\b(off|closed)\b/gi, '休');
  t = t.replace(/\s*;\s*/g, '／');
  return t.trim();
}

/*
 * 住所を継ぎ足す。OSM の addr:city には "栃木県足利市大前町" のように
 * 都道府県や町名まで入っていることがあり、素直に連結すると同じ語が二重になる。
 */
function appendAddr(acc, part) {
  const p = String(part || '').trim();
  if (!p) return acc;
  if (acc.includes(p)) return acc;
  for (let k = Math.min(acc.length, p.length); k > 0; k--) {
    if (acc.endsWith(p.slice(0, k))) return acc + p.slice(k);
  }
  return acc + p;
}

function osmGenre(t) {
  const bits = [];
  String(t.cuisine || '')
    .split(';')
    .filter(Boolean)
    .forEach((c) => {
      const k = c.trim().toLowerCase();
      bits.push(CUISINE_JA[k] || k);
    });
  const base = AMENITY_JA[t.amenity] || SHOP_JA[t.shop] || '';
  if (base) bits.push(base);
  // 重複を落として2つまで
  return [...new Set(bits)].slice(0, 2).join('、');
}

/** 検索・突き合わせ用に名前を正規化する */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　・･,，.。'’"”\-‐–—ー_（）()【】\[\]!！?？&＆]/g, '')
    .replace(/(店|本店|支店|前店)$/, '');
}

/** 2点間の距離（m）。重複判定に使う */
function distM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 国土地理院の市区町村コード表を取る（都道府県・市区町村名の逆引き用） */
async function fetchMuni() {
  const res = await fetch(GSI_MUNI, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('muni.js HTTP ' + res.status);
  const js = await res.text();
  const map = {};
  /*
   * 例: GSI.MUNI_ARRAY["13101"] = '13,東京都,13101,千代田区';
   * ★ muni.js 側は先頭の 0 を落としている（北海道は "1100"）。
   *   逆ジオコーダは "09202" のようにゼロ付きで返すので、数値化して突き合わせる。
   */
  const re = /\["(\d{4,5})"\]\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(js))) {
    const code = String(Number(m[1]));
    const val = m[2];
    const parts = val.split(',');
    // 政令市は「広島市　南区」のように全角スペース区切りで入っているので詰める
    if (parts.length >= 4) map[code] = { pref: parts[1], city: parts[3].replace(/[\s　]+/g, '') };
  }
  return map;
}

/** 緯度経度から都道府県・市区町村を引く（国土地理院・無償キー不要） */
async function reverseGeocode(lat, lng, muni, cache) {
  const key = lat.toFixed(5) + ',' + lng.toFixed(5);
  if (cache[key] !== undefined) return cache[key];
  try {
    const url = `${GSI_REV}?lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const r = j && j.results;
    const code = r && r.muniCd ? String(Number(r.muniCd)) : '';
    if (code && muni[code]) {
      const hit = { pref: muni[code].pref, city: muni[code].city, lv01: r.lv01Nm || '' };
      cache[key] = hit;
      return hit;
    }
    cache[key] = null;
    return null;
  } catch (e) {
    console.error(`  revgeo error (${key}): ${e.message}`);
    return null;
  }
}

async function buildOsm(jhfStores) {
  if (!fs.existsSync(IN_OSM)) {
    console.error('raw-osm.json が無いので OSM 分はスキップ（先に node tools/fetch-osm.js）');
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(IN_OSM, 'utf8'));
  const cache = fs.existsSync(RCACHE) ? JSON.parse(fs.readFileSync(RCACHE, 'utf8')) : {};

  console.error('\nmuni.js 取得中…');
  const muni = await fetchMuni();
  console.error(`  市区町村コード ${Object.keys(muni).length} 件`);

  // 名前の無いものは「店を探す」用途で使えないので落とす（件数だけ報告する）
  const named = (raw.elements || []).filter((e) => e.tags && e.tags.name);
  const unnamed = (raw.elements || []).length - named.length;

  // JHF 側との重複を落とす。誤って消すほうが害が大きいので、条件は厳しめにする。
  const jhfPts = jhfStores.filter((s) => s.geo_ok).map((s) => ({
    lat: s.lat,
    lng: s.lng,
    n: normName(s.name),
  }));
  const jhfNames = new Set(jhfPts.map((p) => p.n).filter(Boolean));

  const out = [];
  const dupes = [];
  for (let i = 0; i < named.length; i++) {
    const e = named[i];
    const t = e.tags;
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lng = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || lng == null) continue;

    const name = decode(t.name);
    const nn = normName(name);

    // 同名、または 80m 以内で名前が部分一致するものは JHF 側を残す
    const nearDup = jhfPts.some(
      (p) =>
        p.n &&
        nn &&
        distM({ lat, lng }, p) <= 80 &&
        (p.n.includes(nn) || nn.includes(p.n))
    );
    if (jhfNames.has(nn) || nearDup) {
      dupes.push(name);
      continue;
    }

    const rev = await reverseGeocode(lat, lng, muni, cache);
    await sleep(250);

    // addr:province には "Shizuoka" のような英字表記も混じる。
    // 都道府県名として妥当なときだけ採用し、そうでなければ逆ジオコーディングの結果を使う。
    const tagPref = new RegExp(`^(${PREF})$`).test(String(t['addr:province'] || '').trim())
      ? String(t['addr:province']).trim()
      : '';
    // 市区町村は国土地理院の逆引きを優先する。addr:city は都道府県や町名まで入っていることがある。
    const osmPref = (rev ? rev.pref : '') || tagPref;
    const osmCity = (rev ? rev.city : '') || decode(t['addr:city'] || '');

    const address = [
      osmPref,
      osmCity,
      // addr:city には町名まで入っていることがある。重なりは appendAddr が吸収するので落とさず通す
      t['addr:city'] || '',
      t['addr:neighbourhood'] || (rev ? rev.lv01 : ''),
      t['addr:block_number'] ? t['addr:block_number'] + '-' : '',
      t['addr:housenumber'] || '',
    ].reduce((acc, p) => appendAddr(acc, decode(p)), '');

    const halal = t['diet:halal'] || t.halal || 'yes';

    out.push({
      id: 'osm-' + e.type + '-' + e.id,
      name,
      name_truncated: false,
      operator: decode(t.brand || t.operator || ''),
      genre: osmGenre(t),
      pref: osmPref,
      city: osmCity,
      zip: t['addr:postcode'] || '',
      address: address.replace(/-$/, ''),
      tel: decode(t.phone || t['contact:phone'] || ''),
      hours: osmHours(t.opening_hours),
      closed: '',
      payment: '',
      // 公式サイトは出さない（JHF 側と同じ方針。リンク切れと「誰の情報か」の問題は出典が変わっても残る）
      web: '',
      lat,
      lng,
      geo_query: '',
      geo_matched: rev ? rev.pref + rev.city + (rev.lv01 || '') : '',
      geo_ok: true,
      // OSM の座標は店そのものの位置なので距離を出してよい
      geo_precision: 'building',
      cert_status: 'osm',
      osm_halal: halal,
      osm_halal_text: OSM_HALAL_TEXT[halal] || OSM_HALAL_TEXT.yes,
      cert_org: 'OpenStreetMap',
      source_url: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    });
    console.error(
      `  [osm ${out.length}] ${name} -> ${rev ? rev.pref + rev.city : '住所不明'} (${halal})`
    );
  }

  fs.writeFileSync(RCACHE, JSON.stringify(cache, null, 2), 'utf8');
  console.error(
    `OSM: 採用 ${out.length} 件 / 名前なしで除外 ${unnamed} 件 / JHFと重複 ${dupes.length} 件` +
      (dupes.length ? `（${dupes.join('、')}）` : '')
  );
  return out;
}

/* ---------------- ここまで OpenStreetMap 分 ---------------- */

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

  const osm = await buildOsm(out);
  const all = out.concat(osm);

  const payload = {
    generated_at: new Date().toISOString(),
    note:
      'ハラール対応の店の一覧。事実情報のみを掲載し、各件に出典URLを付す。' +
      '出どころによって確かさが違うため区分を分けている。' +
      '掲載内容は変わることがあるため、最終確認は必ず店舗へ。',
    sources: [
      {
        org: '一般社団法人ジャパン・ハラール・ファンデーション',
        url: 'https://japanhalal.or.jp/shop',
        cert_status: 'certified',
      },
      {
        org: 'OpenStreetMap contributors',
        url: 'https://www.openstreetmap.org/copyright',
        cert_status: 'osm',
        license: 'ODbL 1.0',
        attribution: '© OpenStreetMap contributors',
      },
    ],
    count: all.length,
    count_by_status: all.reduce((a, s) => {
      a[s.cert_status] = (a[s.cert_status] || 0) + 1;
      return a;
    }, {}),
    geo_failed: all.filter((s) => !s.geo_ok).length,
    geo_approx: all.filter((s) => s.geo_ok && !['building', 'block'].includes(s.geo_precision))
      .length,
    stores: all,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  // file:// で開いても動くように JS 版も出す（fetch は file:// だと CORS で失敗するため）
  fs.writeFileSync(
    OUT.replace(/\.json$/, '.js'),
    'window.HALAL_DATA = ' + JSON.stringify(payload) + ';\n',
    'utf8'
  );
  console.error(
    `\nwrote ${OUT} (${all.length} stores / 内訳 ${JSON.stringify(payload.count_by_status)} / ` +
      `位置不明 ${payload.geo_failed} 件 / おおよその位置 ${payload.geo_approx} 件)`
  );
}

main();
