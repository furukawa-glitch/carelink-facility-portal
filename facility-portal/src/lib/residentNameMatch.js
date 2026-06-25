/** 名簿・帳票・薬局PDFなど、氏名表記の揺れ（スペース・カナ混在）を吸収して照合 */

/**
 * 異体字・旧字体を常用字へ正規化（カイポケ等で旧字体が使えないため）。
 * 表示・照合の双方で使う。誤変換を避けるため、確実なものだけを対象にする。
 */
const KANJI_VARIANT_MAP = {
  '𠮷': '吉', // つちよし（U+20BB7）→ 吉
  '﨑': '崎',
  '髙': '高',
  '德': '徳',
};

export function normalizeKanjiVariants(raw) {
  let s = String(raw ?? '');
  for (const [from, to] of Object.entries(KANJI_VARIANT_MAP)) {
    if (s.includes(from)) s = s.split(from).join(to);
  }
  return s;
}

export function normalizePersonNameForMatch(raw) {
  let s = normalizeKanjiVariants(String(raw ?? ''))
    .replace(/\u3000/g, ' ')
    .trim();
  try {
    s = s.normalize('NFKC');
  } catch {
    /* noop */
  }
  s = s
    .replace(/様\s*$/u, '')
    .replace(/さん\s*$/u, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/[※＊*]+/gu, '')
    .replace(/^[\s※＊*]*\d{1,4}[A-Za-z]?[\s\u3000]+/u, '')
    .replace(/[\s\u3000]+\d{1,4}[A-Za-z]?[\s]*$/u, '')
    .replace(/[\s\u3000\t]+/g, ' ')
    .trim();
  return s;
}

/** 照合用キー（スペース・中黒を除去） */
export function personNameMatchKey(raw) {
  return normalizePersonNameForMatch(raw)
    .replace(/\s/g, '')
    .replace(/・/g, '')
    .replace(/･/g, '');
}

/**
 * 照合候補を複数生成（漢字のみ・スペース除去・カナ部分など）
 * @param {...(string|null|undefined)} sources
 * @returns {string[]}
 */
export function buildPersonNameMatchCandidates(...sources) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const n = normalizePersonNameForMatch(raw);
    if (!n || n.length < 2 || n.length > 40) return;
    const key = personNameMatchKey(n);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(n);
    const compact = n.replace(/\s/g, '');
    if (compact && compact !== n) {
      const ck = personNameMatchKey(compact);
      if (ck && !seen.has(ck)) {
        seen.add(ck);
        out.push(compact);
      }
    }
  };

  for (const src of sources) {
    if (!src) continue;
    add(src);
    const s = normalizePersonNameForMatch(src);
    const idxKanji = s.search(/[一-龥々]/u);
    if (idxKanji >= 0) add(s.slice(idxKanji));
    const kanaOnly = s
      .replace(/[一-龥々\s・･]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^[ァ-ヶー]+$/u.test(kanaOnly.replace(/\s/g, ''))) add(kanaOnly);
    const kanjiOnly = s.replace(/[ァ-ヶーー\s]+/gu, '').trim();
    if (kanjiOnly.length >= 2) add(kanjiOnly);
  }
  return out;
}

function namesLikelySame(aKey, bKey) {
  if (!aKey || !bKey) return false;
  if (aKey === bKey) return true;
  if (aKey.length < 3 || bKey.length < 3) return false;
  if (aKey.includes(bKey) || bKey.includes(aKey)) return true;
  return false;
}

function namesLikelySameLoose(aKey, bKey) {
  if (!aKey || !bKey) return false;
  if (aKey === bKey) return true;
  if (aKey.length >= 2 && bKey.length >= 2 && (aKey.includes(bKey) || bKey.includes(aKey))) return true;
  return namesLikelySame(aKey, bKey);
}

/** 同一文字数で漢字1文字だけ違う（OCR・旧字体など） */
function oneKanjiVariantDiff(a, b) {
  if (a.length !== b.length || a.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
    if (diff > 1) return false;
  }
  return diff === 1;
}

/** 往診カレンダーPDFなどから取った氏名の表記ゆれを広めに許容 */
function expandHomeVisitNameVariants(raw) {
  const s = String(raw ?? '').trim();
  /** @type {string[]} */
  const out = [];
  const add = (x) => {
    const t = String(x ?? '').trim();
    if (!t || out.includes(t)) return;
    out.push(t);
  };
  add(s);
  add(s.replace(/[（(][^）)]*[）)]/gu, '').replace(/\s+/g, ' ').trim());
  add(s.replace(/^[\s※＊*]*\d{1,4}[A-Za-z]?[\s\u3000]*/u, '').trim());
  add(s.replace(/[\s\u3000]+\d{1,4}[A-Za-z]?[\s※＊*]*$/u, '').trim());
  let t = s.replace(/[（(][^）)]*[）)]/gu, '').trim();
  t = t.replace(/^[\s※＊*]*\d{1,4}[A-Za-z]?[\s\u3000]*/u, '').trim();
  add(t);
  const n = normalizePersonNameForMatch(s);
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 2) {
    add(`${parts[1]} ${parts[0]}`);
    add(`${parts[1]}${parts[0]}`);
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {string} rawName
 * @returns {Record<string, unknown> | null}
 */
function findResidentByUniqueLooseName(residents, rawName) {
  const targetKey = personNameMatchKey(rawName);
  if (!targetKey || targetKey.length < 2) return null;

  /** @type {Record<string, unknown>[]} */
  const hits = [];
  for (const res of residents) {
    const fields = [res.name, res.kana, res.nameKana, res.namePhonetic];
    let matched = false;
    for (const raw of fields) {
      const nk = personNameMatchKey(String(raw ?? ''));
      if (!nk) continue;
      if (
        nk === targetKey ||
        namesLikelySameLoose(targetKey, nk) ||
        oneKanjiVariantDiff(targetKey, nk)
      ) {
        matched = true;
        break;
      }
      if (targetKey.length >= 2 && nk.includes(targetKey)) {
        matched = true;
        break;
      }
      if (nk.length >= 3 && targetKey.includes(nk)) {
        matched = true;
        break;
      }
    }
    if (matched) hits.push(res);
  }

  const uniq = [];
  const seen = new Set();
  for (const r of hits) {
    const id = String(r.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(r);
  }
  if (uniq.length === 1) return uniq[0];

  if (targetKey.length >= 2 && targetKey.length <= 6) {
    const bySuffix = residents.filter((r) => {
      const nk = personNameMatchKey(String(r.name ?? ''));
      return nk && (nk.endsWith(targetKey) || nk.startsWith(targetKey));
    });
    const deduped = [];
    const seen2 = new Set();
    for (const r of bySuffix) {
      const id = String(r.id ?? '');
      if (!id || seen2.has(id)) continue;
      seen2.add(id);
      deduped.push(r);
    }
    if (deduped.length === 1) return deduped[0];
  }

  return null;
}

/**
 * 往診カレンダーPDFの氏名 → 名簿（括弧・居室番号・姓のみ・1文字OCR差）
 * @param {Record<string, unknown>[]} residents
 * @param {string} rawName
 * @returns {Record<string, unknown> | null}
 */
export function findResidentForHomeVisitCalendarName(residents, rawName) {
  const list = Array.isArray(residents) ? residents : [];
  for (const v of expandHomeVisitNameVariants(rawName)) {
    const hit = findResidentByPersonNameCandidates(list, buildPersonNameMatchCandidates(v));
    if (hit) return hit;
  }
  return findResidentByUniqueLooseName(list, rawName);
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {string | string[]} candidates
 * @returns {Record<string, unknown> | null}
 */
export function findResidentByPersonNameCandidates(residents, candidates) {
  const list = Array.isArray(candidates)
    ? candidates
    : buildPersonNameMatchCandidates(candidates);
  for (const c of list) {
    const hit = findResidentByPersonName(residents, c);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {Record<string, unknown>[]} residents
 * @param {string} cell
 */
export function findResidentByPersonName(residents, cell) {
  const target = normalizePersonNameForMatch(cell);
  if (!target) return null;
  const targetKey = personNameMatchKey(cell);
  for (const res of residents) {
    const fields = [
      res.name,
      res.kana,
      res.nameKana,
      res.namePhonetic,
    ];
    for (const raw of fields) {
      const n = normalizePersonNameForMatch(String(raw ?? ''));
      if (!n) continue;
      if (n === target) return res;
      const nk = personNameMatchKey(n);
      if (nk && targetKey.length >= 2 && nk === targetKey) return res;
      if (namesLikelySame(targetKey, nk)) return res;
    }
  }
  return null;
}
