/*
 * これを config.js にコピーして値を入れる。config.js は .gitignore 済み。
 * 入れてよいのは anon キーだけ。service_role キーは絶対にここへ書かない
 * （anon は公開前提でRLSで守る鍵、service_role は全権限の鍵）。
 */
window.HALAL_CONFIG = {
  supabaseUrl: 'https://xxxxxxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJ...'
};
