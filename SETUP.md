# ハラールマップ セットアップ

一覧の表示（index.html）は**そのままで動く**。設定が要るのは掲載依頼の受付フォーム（register.html）だけ。

> **2026-07-30 変更**：受付を **Googleフォーム** に一本化した（旧：Supabase直POST）。
> 理由は、掲載依頼が来る段階ではまだ無いのに**鍵（anonキー）をフロントに置く**必要があり、
> かつ**裏取りが追いつかないと溜まるか無確認で通すかになる**ため。
> いまは Supabase を一切使わない＝**鍵が要らない**。将来ちゃんと運用する体力ができたら付録Aで戻せる。

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

## 3. 受付フォームを有効にする（Googleフォーム）

`register.html` は**フォームそのものを持たない**。掲載区分の説明と「お伺いする内容」を出し、
受付は Googleフォームへのリンクで行う。URLが未設定のあいだは「準備中です」と表示され、
**入力させてから失敗する、ということが起きない**。

### A. Googleフォームを作る

質問は以下。★が必須。

| # | 質問 | 形式 | 補足 |
|---|---|---|---|
| 1 | 店名 ★ | 記述式 | |
| 2 | 住所 ★ | 記述式 | 都道府県から、ビル名・階数まで |
| 3 | ジャンル | 記述式 | 例：ラーメン／インド料理／焼肉 |
| 4 | 電話番号 | 記述式 | |
| 5 | 公式サイト・SNS | 記述式 | |
| 6 | 営業時間・定休日 | 記述式 | |
| 7 | 掲載区分 ★ | ラジオボタン | 「認証済み」「自己申告」「一部対応」の3択。**選択肢の文言は register.html の説明とそろえる** |
| 8 | 認証団体名 | 記述式 | 7で「認証済み」を選んだ場合のみ（セクション分岐 or 説明文で案内） |
| 9 | 認証番号 | 記述式 | 同上 |
| 10 | 認証を確認できるページのURL | 記述式 | 同上。第三者が確認できるもの |
| 11 | 対応内容の補足 | 段落 | 豚肉・アルコールの扱い、調理器具や揚げ油を分けているか、礼拝スペースの有無 |
| 12 | ご担当者名 ★ | 記述式 | |
| 13 | メールアドレス ★ | 記述式（メール形式の検証を有効に） | **サイトには掲載しない**と明記する |

フォームの設定：
- **「回答者のメールアドレスを収集する」はオフでよい**（13で聞いているため。オンにするとGoogleアカウントを持たない店が出せなくなる）
- 冒頭の説明文に、register.html と同じ2つの但し書きを入れる
  - 掲載後も修正・削除の依頼を受け付けること／連絡先は掲載しないこと
  - **本サイトはハラール性を保証・証明するものではなく、掲載は認証に代わるものではない**こと
- 「送信後の確認メッセージ」に「内容を確認のうえ、担当よりご連絡します。掲載までお時間をいただきます」と書く

### B. URLを register.html に入れる

`register.html` の末尾スクリプトにある1行を書き換えるだけ。

```js
var FORM_URL = "";   // ← ここに https://docs.google.com/forms/... を入れる
```

`https://` で始まるURLが入ったときだけボタンが出る。空・不正なら「準備中」のまま出ない。

### C. 回答の見かた

Googleフォームの回答はスプレッドシートに溜まる。**鍵もサーバーも不要**。
連絡先が入るので、スプレッドシートは**共有しない**（リンクを知っている全員＝オフのまま）。

---

## 付録A. 自前フォームに戻す場合（Supabase・現在は未使用）

掲載依頼が定常的に来るようになり、裏取りを回せる体制ができたら、以下で自前受付に戻せる。
`config.sample.js` はそのときのために残してある。

### A-1. プロジェクトを作る
1. https://supabase.com にログイン → New project
2. リージョンは Northeast Asia (Tokyo) が無難
3. できたら Project Settings → API から次の2つを控える
   - **Project URL**
   - **anon public** キー
   - ※ **service_role キーは絶対に使わない・送らない**。全権限の鍵で、フロントに置くと誰でも全データを操作できる。

### A-2. テーブルとポリシーを作る
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

### A-3. config.js を置く
```
copy config.sample.js config.js
```
Project URL と anon キーを書き込む。`config.js` は `.gitignore` 済みなのでコミットされない。
あわせて `register.html` に送信処理を戻す（git履歴の 2026-07-30 以前の版に入っている）。

---

## 4. 掲載までの流れ（人の確認を必ず挟む）

依頼 → **中身を確認** → 掲載。

- **「認証済み」は自己申告で通さない。** 認証団体名・番号をもとに、団体の公表情報で裏を取れたものだけ `certified` にする。
  裏が取れなければ `self`（自己申告）に落とすか、掲載を見送る。
- 承認したものを `data/stores.json` に追記する形で反映する（`cert_status` と `source_url` を必ず入れる）。
- 連絡先（担当者名・メールアドレス）は**公開データに入れない**。

## 5. 公開するときの注意

- 位置情報を使うので **https 必須**（GitHub Pages はhttps）。
- 公開前に `git diff --cached --name-only` で `config.js` が混ざっていないか確認する（現在は使っていないが、付録Aで戻したときのため）。
- **外部リクエストの User-Agent に実メールを書かない**（2026-07-29に `tools/` で1件混入を発見）。GitHub noreply を使う。
- 位置情報はブラウザ内でのみ使い、サーバーへ送っていない。この点は画面にも明記してある。
- 試作のあいだは `index.html` の `noindex` と「実際のお店選びの判断には使わないでください」の注記を外さない。

## ファイル構成

```
index.html            一覧（現在地から近い順・絞り込み・Googleマップへのリンク）
register.html         掲載のご依頼（区分の説明＋Googleフォームへのリンク。鍵は不要）
config.sample.js      付録Aで自前受付に戻すとき用（現在は未使用）
serve.js              ローカル確認用サーバー
data/stores.json      公開用データ
data/stores.js        同じ内容のJS版（file:// でも読めるように）
data/jhf-detail.json  出典から取得した生データ
data/raw-jhf.json     一覧ページから拾った元リンク
data/geocode-cache.json  住所→緯度経度のキャッシュ
tools/scrape-jhf.js   出典ページの取得
tools/build-stores.js 整形・ジオコーディング
```
