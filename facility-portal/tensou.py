import asyncio
import csv
import glob
import os
from playwright.async_api import async_playwright

async def main():
    print("--- 【完全自動・施設検索対応版】を開始します ---")
    
    # ファイルの確認
    vital_file = glob.glob('看護記録書Ⅱ*.csv')
    db_file = 'database.csv'
    
    if not vital_file or not os.path.exists(db_file):
        print("❌ エラー: 必要なCSVファイルが足りません。")
        return

    # 1. データベース(名前→施設)を読み込む
    name_to_facility = {}
    with open(db_file, mode='r', encoding='cp932', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name_to_facility[row['氏名'].replace(" ", "").replace("　", "")] = row['事業所名']

    # 2. バイタルデータを読み込む
    vitals_list = []
    with open(vital_file[0], mode='r', encoding='cp932', errors='ignore') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get('利用者名'):
                vitals_list.append(row)

    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
            page = browser.contexts[0].pages[0]
            
            print(f"✅ {len(vitals_list)} 名の転記を開始します。")

            for i, data in enumerate(vitals_list):
                full_name = data['利用者名']
                clean_name = full_name.replace(" ", "").replace("　", "")
                facility = name_to_facility.get(clean_name, "不明")

                print(f"🚀 [{i+1}/{len(vitals_list)}] {full_name} さん ({facility}) を処理中...")

                if facility == "不明":
                    print(f"⚠️ {full_name} さんの施設が不明なためスキップします。")
                    continue

                # --- 施設ボタンをクリック ---
                try:
                    # 画面上の施設名ボタンを探してクリック
                    await page.get_by_role("button", name=facility).click()
                    await asyncio.sleep(1) # 画面切り替わり待ち
                except:
                    print(f"❌ 施設ボタン '{facility}' が見つかりませんでした。")
                    continue

                # --- 利用者名を検索 ---
                # 検索窓に名前を入れてEnter（検索窓の場所は自動で探します）
                await page.get_by_placeholder("利用者名").fill(full_name)
                await page.keyboard.press("Enter")
                await asyncio.sleep(1)

                # --- 「入力」ボタンをクリック ---
                await page.get_by_role("button", name="入力").first.click()
                await asyncio.sleep(1.5)

                # --- バイタル入力 ---
                fields = [
                    data.get('1回目：体温（℃）', ''),
                    data.get('1回目：血圧（高）（mmHg）', ''),
                    data.get('1回目：血圧（低）（mmHg）', ''),
                    data.get('1回目：脈拍（回/分）', ''),
                    data.get('1回目：SpO2（％）', '')
                ]
                
                # 最初の項目（体温）を狙い撃ちしてクリックしてから入力
                first_input = page.locator("input").first
                await first_input.click()
                
                for val in fields:
                    if val: await page.keyboard.type(str(val))
                    await page.keyboard.press("Tab")
                    await asyncio.sleep(0.1)

                # --- 保存して戻る ---
                await page.get_by_role("button", name="保存").click()
                print(f"✅ {full_name} さんの保存が完了しました。")
                await asyncio.sleep(1)

            print("\n✨ すべての作業が完了しました！")
        except Exception as e:
            print(f"❌ エラー発生: {e}")

if __name__ == "__main__":
    asyncio.run(main())