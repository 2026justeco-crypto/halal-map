# ハラールマップ セットアップ

一覧の表示（index.html）は**そのままで動く**。設定が要るのは掲載依頼フォーム（register.html）だけ。

## 1. ローカルで見る

```
node C:\Justeco\Active\halal-map\serve.js
```
→ http://localhost:8788

※ `index.html` を file:// で直接開いても表示できる（データを `data/stores.js` としても出しているため）。
ただし位置情報（Geolocation）は **https か localhost でないとブラウザが許可しない**ので、
現在地の動作確認は上のローカルサーバーか、公開後のURLで行う。

## 2. データの更新

出典＝一般社団法人ジャパン・ハラール・ファンデーション（JHF）の公開「認証実績」ページ。

```
cd C:\Justeco\Active\halal-map
node tools/scrape-jhf.js     # 出典ページから事実情報を取得 → data/jhf-detail.json
node tools/build-stores.js   # 整形＋住所から緯度経度を付与 → data/stores.json / stores.js
```

- 緯度経度は**国土地理院の住所検索API**（無償・APIキー不要）。`data/geocode-cache.json` に結果を貯めるので、
  2回目以降は同じ住所を再照会しない。
- ジオコーディングの精度は `geo_precision` に入る。
  - `building` / `block` … 番地・丁目まで一致。距離と徒歩分を表示してよい。
  - `city` / `pref` … 区や都道府県の中心にしか落ちていない。**画面では「約」を付け「位置はおおよそ」と明記**し、
    地図は座標ではなく住所文字列で開く。
  - ここを一緒くたにすると、実際と離れたピンを正確なもののように見せてしまうので必ず分ける。
- 取得に失敗した店は**黙って消さない**。残してフラグを立てる（載っていない＝無い、と誤解されるため）。

## 3. 掲載依頼フォームを有効にする（Supabase）

### A. プロジェクトを作る
1. https://supabase.com にログイン → New project
2. リージョンは Northeast Asia (Tokyo) が無難
3. できたら Project Settings → API から次の2つを控える
   - **Project URL**
   - **anon public** キー
   - ※ **service_role キーは絶対に使わない・送らない**。全権限の鍵で、フロントに置くと誰でも全データを操作できる。

### B. テーブルとポリシーを作る
SQL Editor で以下を実行する。

```sql
create table if not exists store_submissions (
  id            bigint generated always as identity primary key,
  name          text not null,
  address       text not null,
  genre         text,
  tel           text,
  web           text,
  hours         text,
  cert_status   text not null check (cert_status in ('certified','self','friendly')),
  cert_org      text,
  cert_no       text,
  cert_url      text,
  detail        text,
  contact_name  text,
  contact_email text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_at  timestamptz,
  created_at    timestamptz not null default now()
);

alter table store_submissions enable row level security;

-- 誰でも「申し込みを入れる」ことはできる
create policy "anyone can submit"
  on store_submissions for insert
  to anon
  with check (status = 'pending');

-- 読み取りは許可しない（連絡先が入るため）。確認は管理画面から行う。
-- select / update / delete のポリシーは作らない = anon からは一切読めない。
```

**必ず確認すること**：ポリシー作成後、ログアウト状態（anon）で
`GET /rest/v1/store_submissions` が**空か403で返る**ことを確かめる。
ここが読めてしまうと、応募者のメールアドレスが公開されることになる。

### C. config.js を置く
```
copy config.sample.js config.js
```
Project URL と anon キーを書き込む。`config.js` は `.gitignore` 済みなのでコミットされない。

## 4. 掲載までの流れ（人の確認を必ず挟む）

送信 → `status = 'pending'` で保存 → **中身を確認** → 掲載。

- **「認証済み」は自己申告で通さない。** 認証団体名・番号をもとに、団体の公表情報で裏を取れたものだけ `certified` にする。
  裏が取れなければ `self`（自己申告）に落とすか、掲載を見送る。
- 承認したものを `data/stores.json` に追記する形で反映する（`cert_status` と `source_url` を必ず入れる）。
- 連絡先（contact_name / contact_email）は**公開データに入れない**。

## 5. 公開するときの注意

- 位置情報を使うので **https 必須**（GitHub Pages はhttps）。
- 公開前に `git diff --cached --name-only` で `config.js` が混ざっていないか確認する。
- 位置情報はブラウザ内でのみ使い、サーバーへ送っていない。この点は画面にも明記してある。

## ファイル構成

```
index.html            一覧（現在地から近い順・絞り込み・Googleマップへのリンク）
register.html         掲載依頼フォーム（Supabase）
config.sample.js      → config.js にコピーして使う（config.js は gitignore）
serve.js              ローカル確認用サーバー
data/stores.json      公開用データ
data/stores.js        同じ内容のJS版（file:// でも読めるように）
data/jhf-detail.json  出典から取得した生データ
data/raw-jhf.json     一覧ページから拾った元リンク
data/geocode-cache.json  住所→緯度経度のキャッシュ
tools/scrape-jhf.js   出典ページの取得
tools/build-stores.js 整形・ジオコーディング
```
