import asyncio
import csv
import os
from playwright.async_api import async_playwright

async def main():
    print("--- バイタル転記プログラム（CSV読み込み版）を開始します ---")
    
    # 1. CSVファイルの存在確認
    if not os.path.exists('vital_data.csv'):
        print("❌ エラー: 'vital_data.csv' が見つかりません。")
        return

    # 2. CSVデータの読み込み
    vitals_list = []
    try:
        with open('vital_data.csv', mode='r', encoding='cp932') as f:
            reader = csv.DictReader(f)
            for row in reader:
                vitals_list.append({
                    "name": row['利用者名'].replace("　", " ").strip(),
                    "temp": row['1回目：体温（℃）'],
                    "bp_high": row['1回目：血圧（高）（mmHg）'],
                    "bp_low": row['1回目：血圧（低）（mmHg）'],
                    "pulse": row['1回目：脈拍（回/分）'],
                    "spo2": row['1回目：SpO2（％）']
                })
        print(f"✅ CSVを読み込みました（{len(vitals_list)}名分）")
    except Exception as e:
        print(f"❌ CSV読み込みエラー: {e}")
        return

    # 3. 自作アプリのタブを探して入力
    async with async_playwright() as p:
        print("2. Chromeに接続中...")
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        context = browser.contexts[0]
        
        page = None
        for p_obj in context.pages:
            if "Facility Portal" in await p_obj.title():
                page = p_obj
                print(f"✅ 入力先のタブを見つけました")
                break
        
        if not page:
            print("❌ エラー: 自作アプリのタブが開かれていません。")
            return

        print(f"3. 転記を開始します...")
        for data in vitals_list:
            if not data["name"]: continue
            print(f"   >>> {data['name']} さんを入力中...")
            try:
                last_name = data["name"].split(" ")[0]
                row = page.locator(f"tr:has-text('{last_name}')")
                
                # 入力欄を埋める
                await row.locator('input[placeholder="体温"]').fill(data["temp"])
                await row.locator('input[placeholder="上"]').fill(data["bp_high"])
                await row.locator('input[placeholder="下"]').fill(data["bp_low"])
                await row.locator('input[placeholder="脈"]').fill(data["pulse"])
                await row.locator('input[placeholder="SPO2"]').fill(data["spo2"])
            except:
                print(f"   ⚠️ {data['name']} さんが見つかりませんでした。")

        print("✨ すべて完了しました！")

if __name__ == "__main__":
    asyncio.run(main())