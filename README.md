# 投資成績管理

保有する株式・投資信託の年ごとの成績（値動き＋配当金）を表示するページ。

- `index.html` / `app.js` / `style.css`：ページ本体（GitHub Pagesで公開）
- `firebase-config.js`：Firebaseの設定（売買記録・配当修正の保存、Googleログイン）
- `data/seed.json`：初期データ（2026年初の保有と2026年1〜9月の売買）
- `data/market.json`：最新価格（GitHub Actionsが平日21時に更新）
- `data/yearend/YYYY.json`：各年の年末価格（その年の最終更新値がそのまま年末値になる）
- `data/dividends.json`：1株あたり配当の履歴（追記のみ）
- `scripts/update_market.py`：価格・配当の取得スクリプト

成績 ＝ 年末（現在）評価額 − 年初評価額 − 買付額 ＋ 売却額 ＋ 配当金（基準日の年で計上）
