/**
 * Google Apps Script — ヒヤリハット周知管理簿へ追記（Web アプリとしてデプロイ）
 *
 * 【設置】対象のスプレッドシートで「拡張機能」→「Apps Script」→ このファイルの内容をすべて貼り付け（既存コードは置き換え）
 *
 * 【必須】下の APP_SECRET を長いランダム文字列に変更（.env の VITE_NEAR_MISS_APP_SECRET と同じ値）
 *
 * 【デプロイ】「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   実行するユーザー: 自分
 *   アクセスできるユーザー: 全員（匿名ユーザーを含む）
 *   発行された URL を facility-portal/.env.local に
 *   VITE_NEAR_MISS_APPS_SCRIPT_URL=（そのURL）
 *
 * 【シート】未作成でも可。初回追記時に「報告」「確認ログ」「周知確認ログ」「事故報告データ」が自動作成されます。
 *
 * 【用紙タブへの自動反映】
 * 同一ブック内に「用紙」という名前のシートがあり、かつ A1 が「レコードID」のときだけ、
 * 「報告」と同じ1行を「用紙」にも追記します（台帳と同じログ形式の複製）。
 * マージセル入りの様式シートには使わないでください（上書き破損の恐れ）。
 * 様式のみのシートでは、別シートで =FILTER(報告!A:I, LEN(報告!A:A)) 等で参照する運用を推奨します。
 *
 * アプリからの呼び出しは doPost のみ（JSON body: secret, action, row）
 */

var APP_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    var incoming = body.secret != null ? String(body.secret).trim() : '';
    var expected = String(APP_SECRET).trim();
    if (!incoming || incoming !== expected) {
      return jsonOut({ ok: false, message: 'unauthorized' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'appendReport') {
      var sh = ss.getSheetByName('報告');
      if (!sh) sh = ss.insertSheet('報告');
      ensureReportHeader_(sh);
      sh.appendRow(body.row);
      var mirror = mirrorReportToYoushi_(ss, body.row);
      return jsonOut({ ok: true, mirror: mirror });
    } else if (body.action === 'appendAck') {
      var sh2 = ss.getSheetByName('確認ログ');
      if (!sh2) sh2 = ss.insertSheet('確認ログ');
      ensureAckHeader_(sh2);
      sh2.appendRow(body.row);
    } else if (body.action === 'appendAwarenessLog') {
      var sh3 = ss.getSheetByName('周知確認ログ');
      if (!sh3) sh3 = ss.insertSheet('周知確認ログ');
      ensureAwarenessLogHeader_(sh3);
      sh3.appendRow(body.row);
    } else if (body.action === 'appendAccidentReport') {
      var sh4 = ss.getSheetByName('事故報告データ');
      if (!sh4) sh4 = ss.insertSheet('事故報告データ');
      ensureAccidentReportHeader_(sh4);
      sh4.appendRow(body.row);
    } else {
      return jsonOut({ ok: false, message: 'unknown action' });
    }
    return jsonOut({ ok: true, mirror: null });
  } catch (err) {
    return jsonOut({ ok: false, message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 「用紙」シートがログ用（A1=レコードID）のときのみ、報告行を複製する。
 * @returns {{ mirrored: boolean, skipped?: boolean, reason?: string }}
 */
function mirrorReportToYoushi_(ss, row) {
  var form = ss.getSheetByName('用紙');
  if (!form) {
    return { mirrored: false, skipped: true, reason: '「用紙」シートが無いためスキップ（報告のみ追記済み）' };
  }
  var lastRow = form.getLastRow();
  if (lastRow === 0) {
    ensureReportHeader_(form);
    form.appendRow(row);
    return { mirrored: true };
  }
  var a1 = String(form.getRange(1, 1).getValue() || '').trim();
  if (a1 !== 'レコードID') {
    return {
      mirrored: false,
      skipped: true,
      reason:
        '「用紙」のA1が「レコードID」ではないため自動追記をスキップしました。様式シートの場合は破損防止のため、別シートで報告を参照するか、ログ用の「用紙」シートを用意してください。',
    };
  }
  form.appendRow(row);
  return { mirrored: true };
}

function ensureReportHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'レコードID',
      '作成日時',
      '施設キー',
      '重要度',
      'カテゴリ',
      'タイトル',
      '概要',
      '下書きJSON',
      'アーカイブ',
    ]);
  }
}

function ensureAckHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['ログID', '周知ID', '施設キー', '職員ID', '職員名', '確認日時']);
  }
}

function ensureAwarenessLogHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['日時', '種別', 'タイトル', '名前', '部署', '施設']);
  }
}

function ensureAccidentReportHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      '保存日時',
      '事故報告ID',
      '施設キー',
      '施設名',
      '部署',
      '利用者ID',
      '利用者名',
      '発生場所',
      '事故種別',
      'draftJson',
    ]);
  }
}
