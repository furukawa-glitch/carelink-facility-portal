import React, { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  Check,
  Loader2,
  Activity,
  Utensils,
  Footprints,
  Toilet,
  Pencil,
  Trash2,
  X,
  NotebookPen,
  Mic,
  Square,
} from 'lucide-react';
import { sendOrQueue } from '../lib/queue.js';
import { pullEvents } from '../lib/api.js';
import { createRecognizer, isSpeechRecognitionSupported, translateText } from '../lib/speech.js';
import {
  buildVitalEvent,
  buildPatrolEvent,
  buildUrineEvent,
  buildStoolEvent,
  buildMealEvent,
  buildFluidEvent,
  buildNoteEvent,
  describeEvent,
  voidEvent,
  withIdentity,
  startOfTodayIso,
} from '../lib/events.js';

const TABS = [
  { key: 'vital', label: 'バイタル', icon: Activity },
  { key: 'meal', label: '食事・水分', icon: Utensils },
  { key: 'patrol', label: '巡視', icon: Footprints },
  { key: 'excretion', label: '排泄', icon: Toilet },
  { key: 'note', label: '様子', icon: NotebookPen },
];

/** 様子メモ1行あたりの目安文字数 */
const NOTE_MAXLEN = 30;

/** プルダウンで選べる定型文（日中・夜勤共通。先頭の空は「選択」） */
const NOTE_PRESETS = [
  '日中フロアで過ごされている。',
  '日中テレビをみて過ごされている。',
  '居室で休まれている。',
  '左側臥位で眠られている。',
  '右側臥位で眠られている。',
  '仰臥位で眠られている。',
  '開眼されている。',
  '閉眼し休まれている。',
  '傾眠傾向。',
  '声かけに反応あり。',
  '落ち着いて過ごされている。',
];

const WARI = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
// 閲覧側（facility-portal）の固定selectと値を一致させること。
// 排尿: HOURLY_URINE_OPTIONS / 便量: STOOL_VOLUME_OPTIONS / 便性状: STOOL_CHARACTER_OPTIONS
// 排尿は「方法」と「量」を独立に選べるようにする（両方選んでも1記録＝回数1）。
// facility-portal へは「方法・量」を中点で連結した1コードで送る（カウントは1のまま）。
const URINE_METHODS = ['トイレ', '尿器', '失禁', '導尿'];
const URINE_AMOUNTS = ['少量', '中量', '多量'];
const URINE_NEEDS_ML = new Set(['導尿']);

/** 連結コード（例「トイレ・中量」「導尿」）を 方法/量 に分解。旧データ(カテ等)も吸収 */
function parseUrineCode(raw) {
  const parts = String(raw ?? '')
    .split('・')
    .map((s) => s.trim())
    .filter(Boolean);
  let method = '';
  let amount = '';
  for (const p of parts) {
    const m = p === 'カテ' ? '導尿' : p;
    if (URINE_METHODS.includes(m)) method = m;
    else if (URINE_AMOUNTS.includes(m)) amount = m;
    else if (!method) method = m;
  }
  return { method, amount };
}
const STOOL_VOLUME = ['多', '中', '小'];
const STOOL_CHARACTER = ['普通便', '軟便', '硬便', '水様便', '泥状便'];
const MEAL_TIMES = ['朝', '昼', '夜', '間食'];
// エンシュア・ソリタの摂取量（facility-portal の ENSURE_PORTION_OPTIONS と一致させること）
const ENSURE_PORTIONS = ['1/3', '1/2', '2/3', '1缶'];

/** 食事metaからエンシュア/ソリタの割合を復元（生meta優先、無ければmealAmountから抽出） */
function parseMealMetaPortion(meta, which) {
  const raw = which === 'ensure' ? meta?.ensurePortion : meta?.solitaPortion;
  const v = String(raw ?? '').trim();
  if (v) return v;
  const amount = String(meta?.mealAmount ?? '');
  const re = which === 'ensure' ? /エンシュア(1\/3|1\/2|2\/3|1缶)/u : /ソリタ(1\/3|1\/2|2\/3|1缶)/u;
  const m = amount.match(re);
  return m ? m[1] : '';
}

/** 食事metaから間食・補助食の自由記述を復元（生meta優先、無ければ「／」以降を抽出） */
function parseMealMetaExtras(meta) {
  const v = String(meta?.mealExtras ?? '').trim();
  if (v) return v;
  const amount = String(meta?.mealAmount ?? '');
  const idx = amount.indexOf('／');
  return idx >= 0 ? amount.slice(idx + 1).trim() : '';
}

/** 今日の日付 + 指定 time(HH:MM) を ISO に。time 未指定なら現在時刻。 */
function tsFromTime(time) {
  const t = String(time ?? '').trim();
  if (!/^\d{2}:\d{2}$/.test(t)) return new Date().toISOString();
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hhmmFromTs(ts) {
  const d = new Date(String(ts ?? ''));
  if (!Number.isFinite(d.getTime())) return nowHHMM();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 今日（端末ローカル日付）かどうか */
function isTodayLocal(ts) {
  const d = new Date(String(ts ?? ''));
  if (!Number.isFinite(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** この利用者の記録だけ、無効化されていないものを新しい順に */
function filterResidentToday(events, resident) {
  const id = String(resident?.id ?? '').trim();
  const name = String(resident?.name ?? '').trim();
  return (Array.isArray(events) ? events : [])
    .filter((e) => {
      if (e?.voided === true || (e?.meta && e.meta.voided === true)) return false;
      if (!isTodayLocal(e?.ts)) return false;
      const eid = String(e?.residentId ?? '').trim();
      const enm = String(e?.residentName ?? '').trim();
      return (eid && eid === id) || (enm && enm === name);
    })
    .sort((a, b) => new Date(b?.ts ?? 0) - new Date(a?.ts ?? 0));
}

const KIND_COLOR = {
  バイタル: 'bg-rose-100 text-rose-700',
  巡視: 'bg-violet-100 text-violet-700',
  排尿: 'bg-sky-100 text-sky-700',
  排便: 'bg-amber-100 text-amber-700',
  水分: 'bg-cyan-100 text-cyan-700',
  様子: 'bg-emerald-100 text-emerald-700',
};

/** @param {{ resident: object; staffName: string; onBack: () => void }} props */
export function InputScreen({ resident, staffName, onBack }) {
  const [tab, setTab] = useState('vital');
  const [time, setTime] = useState(nowHHMM());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [records, setRecords] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  /** 編集中の元イベント（null = 新規） */
  const [editing, setEditing] = useState(null);
  /** 編集時にパネルへ渡す初期値（再マウントで反映） */
  const [editInitial, setEditInitial] = useState(null);
  const [editNonce, setEditNonce] = useState(0);

  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const all = await pullEvents(startOfTodayIso());
      setRecords(filterResidentToday(all, resident));
    } catch {
      /* オフライン等。一覧は次回更新で取得 */
    } finally {
      setLoadingRecords(false);
    }
  }, [resident]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const record = async (event) => {
    if (busy) return;
    setBusy(true);
    setFlash('');
    try {
      let ev = event;
      const isEdit = editing && event?.type === editing.type;
      if (isEdit) ev = withIdentity(event, editing);
      const { sent } = await sendOrQueue([ev]);
      const verb = isEdit ? '修正' : '記録';
      setFlash(sent ? `${verb}しました（${time}）` : `保存しました（送信待ち・${time}）`);
      window.setTimeout(() => setFlash(''), 2500);
      setEditing(null);
      setEditInitial(null);
      setEditNonce((n) => n + 1);
      void loadRecords();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ev) => {
    if (busy) return;
    const d = describeEvent(ev);
    if (!window.confirm(`${d.time} ${d.kind} ${d.summary}\nこの記録を取り消します。よろしいですか？`)) return;
    setBusy(true);
    try {
      await sendOrQueue([voidEvent(ev)]);
      setRecords((prev) => prev.filter((r) => String(r.id) !== String(ev.id)));
      setFlash('取り消しました');
      window.setTimeout(() => setFlash(''), 2000);
      if (editing && String(editing.id) === String(ev.id)) {
        setEditing(null);
        setEditInitial(null);
      }
      void loadRecords();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (ev) => {
    const meta = ev?.meta && typeof ev.meta === 'object' ? ev.meta : {};
    const type = String(ev?.type ?? '');
    let nextTab = 'vital';
    let initial = null;
    if (type === 'vital_snapshot') {
      nextTab = 'vital';
      initial = {
        temp: String(meta.temp ?? ''),
        bpUpper: String(meta.bpUpper ?? ''),
        bpLower: String(meta.bpLower ?? ''),
        pulse: String(meta.pulse ?? ''),
        spo2: String(meta.spo2 ?? ''),
      };
    } else if (type === 'meal') {
      nextTab = 'meal';
      initial = {
        kind: 'meal',
        mealTime: String(meta.mealSlot ?? '').trim() || (meta.note === '間食' ? '間食' : ''),
        mealStaple: String(meta.mealStaple ?? '').replace(/割$/u, ''),
        mealSide: String(meta.mealSide ?? '').replace(/割$/u, ''),
        medicationTaken: meta.medicationTaken === 'yes' ? 'yes' : '',
        ensurePortion: parseMealMetaPortion(meta, 'ensure'),
        solitaPortion: parseMealMetaPortion(meta, 'solita'),
        mealExtras: parseMealMetaExtras(meta),
        waterMl: '',
      };
    } else if (type === 'fluid_intake') {
      nextTab = 'meal';
      initial = { kind: 'fluid', mealTime: '', mealStaple: '', mealSide: '', waterMl: String(meta.waterMl ?? '') };
    } else if (type === 'patrol') {
      nextTab = 'patrol';
      initial = {};
    } else if (type === 'excretion') {
      nextTab = 'excretion';
      initial = {
        urineCode: String(meta.urineCode ?? ''),
        urineMl: String(meta.measuredUrineMl ?? ''),
        stoolVolume: String(meta.stoolVolume ?? ''),
        stoolCharacter: String(meta.stoolCharacter ?? ''),
      };
    } else if (type === 'note') {
      nextTab = 'note';
      initial = { dayNote: String(meta.dayNote ?? ''), nightNote: String(meta.nightNote ?? '') };
    }
    setEditing(ev);
    setEditInitial(initial);
    setEditNonce((n) => n + 1);
    setTab(nextTab);
    setTime(hhmmFromTs(ev?.ts));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditInitial(null);
    setEditNonce((n) => n + 1);
  };

  const ts = () => tsFromTime(time);
  const panelKey = `${tab}-${editNonce}`;
  // 今日の様子メモ（あれば）をプルダウン/手入力の初期値に使う
  const todayNote = records.find((e) => String(e?.type ?? '') === 'note') ?? null;
  const todayNoteInitial = todayNote
    ? {
        dayNote: String(todayNote.meta?.dayNote ?? ''),
        nightNote: String(todayNote.meta?.nightNote ?? ''),
      }
    : null;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-lg bg-white px-3 py-2 font-bold text-slate-600 shadow-sm"
        >
          <ChevronLeft className="h-5 w-5" /> 一覧
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-2xl font-black text-slate-800">{resident.name}</div>
          {resident.room && <div className="text-sm text-slate-500">居室 {resident.room}</div>}
        </div>
        <label className="text-right text-xs font-bold text-slate-500">
          時刻
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="mt-0.5 block rounded-lg border border-slate-300 px-2 py-1 text-base font-bold"
          />
        </label>
      </div>

      {editing && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-3 font-bold text-amber-800">
          <Pencil className="h-5 w-5" /> 修正中（{describeEvent(editing).kind}）。値を直して記録すると上書きされます。
          <button type="button" onClick={cancelEdit} className="ml-auto rounded-lg bg-white/70 px-2 py-1 text-sm">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-slate-200 p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                if (editing) cancelEdit();
              }}
              className={`flex flex-col items-center gap-0.5 rounded-lg py-2 text-xs font-black ${
                active ? 'bg-white text-teal-700 shadow' : 'text-slate-500'
              }`}
            >
              <Icon className="h-5 w-5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {flash && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-black text-white">
          <Check className="h-5 w-5" /> {flash}
        </div>
      )}

      {tab === 'vital' && (
        <VitalPanel
          key={panelKey}
          busy={busy}
          initial={editing && editInitial ? editInitial : null}
          onRecord={(v) => record(buildVitalEvent(resident, v, staffName, ts()))}
        />
      )}
      {tab === 'meal' && (
        <MealPanel
          key={panelKey}
          busy={busy}
          initial={editing && editInitial ? editInitial : null}
          onRecordMeal={(v) => record(buildMealEvent(resident, v, staffName, ts()))}
          onRecordFluid={(v) => record(buildFluidEvent(resident, v, staffName, ts()))}
        />
      )}
      {tab === 'patrol' && (
        <PatrolPanel busy={busy} onRecord={() => record(buildPatrolEvent(resident, staffName, ts()))} />
      )}
      {tab === 'excretion' && (
        <ExcretionPanel
          key={panelKey}
          busy={busy}
          initial={editing && editInitial ? editInitial : null}
          onRecordUrine={(v) => record(buildUrineEvent(resident, v, staffName, ts()))}
          onRecordStool={(v) => record(buildStoolEvent(resident, v, staffName, ts()))}
        />
      )}
      {tab === 'note' && (
        <NotePanel
          key={`note-${editNonce}-${todayNote ? String(todayNote.id) : 'new'}`}
          busy={busy}
          initial={editing && editInitial ? editInitial : todayNoteInitial}
          onRecordNote={(v) => record(buildNoteEvent(resident, v, staffName, ts()))}
        />
      )}

      <TodayRecords
        records={records}
        loading={loadingRecords}
        busy={busy}
        editingId={editing ? String(editing.id) : ''}
        onEdit={startEdit}
        onRemove={remove}
        onReload={() => void loadRecords()}
      />
    </div>
  );
}

function TodayRecords({ records, loading, busy, editingId, onEdit, onRemove, onReload }) {
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-black text-slate-700">今日の記録</h2>
        <button
          type="button"
          onClick={onReload}
          className="rounded-lg bg-white px-3 py-1 text-sm font-bold text-slate-500 shadow-sm"
        >
          {loading ? '更新中…' : '更新'}
        </button>
      </div>
      {records.length === 0 ? (
        <p className="rounded-xl bg-white px-4 py-6 text-center text-slate-400 shadow-sm">
          {loading ? '読み込み中…' : '今日の記録はまだありません。'}
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((ev) => {
            const d = describeEvent(ev);
            const isEditing = editingId && String(ev.id) === editingId;
            return (
              <li
                key={String(ev.id)}
                className={`flex items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-sm ${
                  isEditing ? 'ring-2 ring-amber-400' : ''
                }`}
              >
                <span className="w-12 shrink-0 text-base font-black tabular-nums text-slate-500">{d.time}</span>
                <span
                  className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-black ${
                    KIND_COLOR[d.kind] ?? 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {d.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700">{d.summary}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onEdit(ev)}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-black text-white disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4" /> 修正
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(ev)}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1.5 text-xs font-black text-white disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" /> 取消
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BigRecordButton({ busy, children, onClick, color = 'teal' }) {
  const colors = {
    teal: 'bg-teal-600',
    sky: 'bg-sky-600',
    amber: 'bg-amber-600',
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-5 text-xl font-black text-white disabled:opacity-60 ${colors[color]}`}
    >
      {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Check className="h-6 w-6" />}
      {children}
    </button>
  );
}

function NumField({ label, unit, value, onChange, placeholder }) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-600">{label}</span>
      <span className="mt-1 flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder={placeholder}
          className="w-full text-2xl font-black"
        />
        {unit && <span className="text-sm font-bold text-slate-400">{unit}</span>}
      </span>
    </label>
  );
}

function VitalPanel({ busy, onRecord, initial }) {
  const [v, setV] = useState(
    initial ?? { temp: '', bpUpper: '', bpLower: '', pulse: '', spo2: '' }
  );
  const set = (k) => (val) => setV((prev) => ({ ...prev, [k]: val }));
  const hasAny = Object.values(v).some((x) => String(x).trim());
  return (
    <div className="space-y-3">
      <NumField label="体温" unit="℃" value={v.temp} onChange={set('temp')} placeholder="36.5" />
      <div className="grid grid-cols-2 gap-3">
        <NumField label="血圧（上）" unit="mmHg" value={v.bpUpper} onChange={set('bpUpper')} placeholder="120" />
        <NumField label="血圧（下）" unit="mmHg" value={v.bpLower} onChange={set('bpLower')} placeholder="80" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label="脈拍" unit="回" value={v.pulse} onChange={set('pulse')} placeholder="70" />
        <NumField label="SpO2" unit="%" value={v.spo2} onChange={set('spo2')} placeholder="98" />
      </div>
      <BigRecordButton busy={busy} onClick={() => onRecord(v)}>
        {hasAny ? 'バイタルを記録' : '記録（入力なし）'}
      </BigRecordButton>
    </div>
  );
}

function WariSelect({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-lg font-bold"
      >
        <option value="">—</option>
        {WARI.map((w) => (
          <option key={w} value={w}>
            {w}割
          </option>
        ))}
      </select>
    </label>
  );
}

function PortionSelect({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-lg font-bold"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

const MEAL_EXTRAS_MAXLEN = 40;

function MealPanel({ busy, onRecordMeal, onRecordFluid, initial }) {
  const [mealTime, setMealTime] = useState(initial?.mealTime ?? '');
  const [mealStaple, setMealStaple] = useState(initial?.mealStaple ?? '');
  const [mealSide, setMealSide] = useState(initial?.mealSide ?? '');
  const [ensurePortion, setEnsurePortion] = useState(initial?.ensurePortion ?? '');
  const [solitaPortion, setSolitaPortion] = useState(initial?.solitaPortion ?? '');
  const [mealExtras, setMealExtras] = useState(initial?.mealExtras ?? '');
  const [medTaken, setMedTaken] = useState(initial?.medicationTaken === 'yes' ? 'yes' : '');
  const [waterMl, setWaterMl] = useState(initial?.waterMl ?? '');
  const [voiceLang, setVoiceLang] = useState('ja');
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState('');
  const speechOK = isSpeechRecognitionSupported();

  const appendExtras = (text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    setMealExtras((prev) => {
      const joined = prev ? `${prev}${prev.endsWith('。') ? '' : '、'}${t}` : t;
      return joined.slice(0, MEAL_EXTRAS_MAXLEN);
    });
  };

  const startVoice = () => {
    if (listening) return;
    setNotice('');
    setListening(true);
    const lang = voiceLang === 'en' ? 'en-US' : 'ja-JP';
    const recog = createRecognizer(lang, {
      onResult: async (text) => {
        if (voiceLang === 'en') {
          const ja = await translateText(text, 'en', 'ja');
          if (ja) {
            appendExtras(ja);
          } else {
            appendExtras(text);
            setNotice('このブラウザは自動翻訳に未対応のため、英語のまま入力しました（Chrome 最新版で日本語化されます）。');
          }
        } else {
          appendExtras(text);
        }
      },
      onError: (m) => {
        if (m) setNotice(m);
      },
      onEnd: () => setListening(false),
    });
    recog.start();
  };

  const resetMeal = () => {
    setMealStaple('');
    setMealSide('');
    setEnsurePortion('');
    setSolitaPortion('');
    setMealExtras('');
    setMedTaken('');
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="text-sm font-bold text-slate-600">食事</div>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {MEAL_TIMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setMealTime(t)}
              className={`rounded-xl py-3 text-lg font-black ${
                mealTime === t ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <WariSelect label="主食" value={mealStaple} onChange={setMealStaple} />
          <WariSelect label="副食" value={mealSide} onChange={setMealSide} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <PortionSelect label="エンシュア" value={ensurePortion} onChange={setEnsurePortion} options={ENSURE_PORTIONS} />
          <PortionSelect label="ソリタ" value={solitaPortion} onChange={setSolitaPortion} options={ENSURE_PORTIONS} />
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-slate-600">間食・補助食（食べた内容）</span>
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-black">
              <button
                type="button"
                onClick={() => setVoiceLang('ja')}
                className={`rounded-md px-2 py-1 ${voiceLang === 'ja' ? 'bg-white text-teal-700 shadow' : 'text-slate-500'}`}
              >
                日本語
              </button>
              <button
                type="button"
                onClick={() => setVoiceLang('en')}
                className={`rounded-md px-2 py-1 ${voiceLang === 'en' ? 'bg-white text-teal-700 shadow' : 'text-slate-500'}`}
              >
                English
              </button>
            </div>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={mealExtras}
              onChange={(e) => setMealExtras(e.target.value.slice(0, MEAL_EXTRAS_MAXLEN))}
              maxLength={MEAL_EXTRAS_MAXLEN}
              placeholder="例: パン半分、バナナ、ゼリー"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-2 text-base font-bold text-slate-800"
            />
            <button
              type="button"
              disabled={!speechOK}
              onClick={startVoice}
              className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-black text-white disabled:opacity-40 ${
                listening ? 'animate-pulse bg-rose-600' : 'bg-teal-600'
              }`}
              title={speechOK ? '音声で入力' : 'このブラウザは音声入力に未対応です'}
            >
              {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {listening ? '停止' : voiceLang === 'en' ? '英語' : '音声'}
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            「English」を選ぶと、英語で話した内容を日本語に変換して入力します。
          </p>
        </div>

        <div className="mt-3">
          <span className="text-sm font-bold text-slate-600">内服</span>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMedTaken((p) => (p === 'yes' ? '' : 'yes'))}
              className={`rounded-xl py-3 text-base font-black ${
                medTaken === 'yes' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              内服済
            </button>
            <button
              type="button"
              onClick={() => setMedTaken('')}
              className={`rounded-xl py-3 text-base font-black ${
                medTaken === '' ? 'bg-slate-300 text-slate-800' : 'bg-slate-100 text-slate-500'
              }`}
            >
              なし
            </button>
          </div>
        </div>

        {notice && (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{notice}</div>
        )}

        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            onClick={() => {
              onRecordMeal({
                mealTime,
                mealStaple,
                mealSide,
                ensurePortion,
                solitaPortion,
                mealExtras,
                medicationTaken: medTaken,
              });
              resetMeal();
            }}
          >
            食事を記録
          </BigRecordButton>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="text-sm font-bold text-slate-600">水分</div>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {['100', '150', '200', '250'].map((ml) => (
            <button
              key={ml}
              type="button"
              onClick={() => setWaterMl(ml)}
              className={`rounded-xl py-3 text-base font-black ${
                waterMl === ml ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {ml}
            </button>
          ))}
        </div>
        <div className="mt-2">
          <NumField label="水分量" unit="ml" value={waterMl} onChange={setWaterMl} placeholder="200" />
        </div>
        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            color="sky"
            onClick={() => {
              onRecordFluid({ waterMl });
              setWaterMl('');
            }}
          >
            水分を記録
          </BigRecordButton>
        </div>
      </div>
    </div>
  );
}

function PatrolPanel({ busy, onRecord }) {
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-white px-4 py-3 text-slate-600 shadow-sm">
        ボタンを押すと、上の「時刻」でこの利用者の巡視を1件記録します。
      </p>
      <BigRecordButton busy={busy} onClick={onRecord}>
        巡視を記録
      </BigRecordButton>
    </div>
  );
}

function ExcretionPanel({ busy, onRecordUrine, onRecordStool, initial }) {
  const initUrine = parseUrineCode(initial?.urineCode);
  const [urineMethod, setUrineMethod] = useState(initUrine.method);
  const [urineAmount, setUrineAmount] = useState(initUrine.amount);
  const [urineMl, setUrineMl] = useState(initial?.urineMl ?? '');
  const [stoolVolume, setStoolVolume] = useState(initial?.stoolVolume ?? '');
  const [stoolCharacter, setStoolCharacter] = useState(initial?.stoolCharacter ?? '');

  const toggle = (setter) => (v) => setter((prev) => (prev === v ? '' : v));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="text-sm font-bold text-slate-600">排尿</div>
        <div className="mt-2">
          <span className="text-xs font-bold text-slate-500">方法</span>
          <div className="mt-1 grid grid-cols-4 gap-2">
            {URINE_METHODS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggle(setUrineMethod)(c)}
                className={`rounded-xl py-3 text-base font-black ${
                  urineMethod === c ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2">
          <span className="text-xs font-bold text-slate-500">量</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {URINE_AMOUNTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => toggle(setUrineAmount)(c)}
                className={`rounded-xl py-3 text-lg font-black ${
                  urineAmount === c ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        {URINE_NEEDS_ML.has(urineMethod) && (
          <div className="mt-2">
            <NumField label="尿量" unit="ml" value={urineMl} onChange={setUrineMl} placeholder="200" />
          </div>
        )}
        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            color="sky"
            onClick={() => {
              const urineCode = [urineMethod, urineAmount].filter(Boolean).join('・');
              onRecordUrine({ urineCode, measuredUrineMl: urineMl });
              setUrineMethod('');
              setUrineAmount('');
              setUrineMl('');
            }}
          >
            排尿を記録
          </BigRecordButton>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="text-sm font-bold text-slate-600">排便</div>
        <div className="mt-2">
          <span className="text-xs font-bold text-slate-500">量</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {STOOL_VOLUME.map((vv) => (
              <button
                key={vv}
                type="button"
                onClick={() => setStoolVolume(vv)}
                className={`rounded-xl py-3 text-lg font-black ${
                  stoolVolume === vv ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {vv}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2">
          <span className="text-xs font-bold text-slate-500">性状</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {STOOL_CHARACTER.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setStoolCharacter(c)}
                className={`rounded-xl py-3 text-base font-black ${
                  stoolCharacter === c ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-700'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            color="amber"
            onClick={() => {
              onRecordStool({ stoolVolume, stoolCharacter });
              setStoolVolume('');
              setStoolCharacter('');
            }}
          >
            排便を記録
          </BigRecordButton>
        </div>
      </div>
    </div>
  );
}

function NoteRow({ label, value, onChange, onPreset, voiceLang, onVoice, listening, speechOK }) {
  const len = value.length;
  const over = len > NOTE_MAXLEN;
  return (
    <div className="rounded-xl border border-slate-200 p-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-black text-slate-700">{label}</span>
        <span className={`text-xs font-bold ${over ? 'text-rose-600' : 'text-slate-400'}`}>
          {len}/{NOTE_MAXLEN}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={NOTE_MAXLEN}
        placeholder="様子を入力（プルダウン・音声でも入力できます）"
        className="mt-1 w-full resize-none rounded-lg border border-slate-300 px-2 py-2 text-base font-bold text-slate-800"
      />
      <div className="mt-1 flex items-center gap-2">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onPreset(e.target.value);
            e.target.value = '';
          }}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-bold text-slate-700"
        >
          <option value="">定型文を選ぶ…</option>
          {NOTE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!speechOK}
          onClick={onVoice}
          className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-black text-white disabled:opacity-40 ${
            listening ? 'animate-pulse bg-rose-600' : 'bg-teal-600'
          }`}
          title={speechOK ? '音声で入力' : 'このブラウザは音声入力に未対応です'}
        >
          {listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {listening ? '停止' : voiceLang === 'en' ? '英語' : '音声'}
        </button>
      </div>
    </div>
  );
}

function NotePanel({ busy, onRecordNote, initial }) {
  const [dayNote, setDayNote] = useState(initial?.dayNote ?? '');
  const [nightNote, setNightNote] = useState(initial?.nightNote ?? '');
  const [voiceLang, setVoiceLang] = useState('ja');
  const [listening, setListening] = useState('');
  const [notice, setNotice] = useState('');
  const speechOK = isSpeechRecognitionSupported();

  const appendTo = (which, text) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    const setter = which === 'day' ? setDayNote : setNightNote;
    setter((prev) => {
      const joined = prev ? `${prev}${prev.endsWith('。') ? '' : ' '}${t}` : t;
      return joined.slice(0, NOTE_MAXLEN);
    });
  };

  const startVoice = (which) => {
    if (listening) return;
    setNotice('');
    setListening(which);
    const lang = voiceLang === 'en' ? 'en-US' : 'ja-JP';
    const recog = createRecognizer(lang, {
      onResult: async (text) => {
        if (voiceLang === 'en') {
          const ja = await translateText(text, 'en', 'ja');
          if (ja) {
            appendTo(which, ja);
          } else {
            appendTo(which, text);
            setNotice('このブラウザは自動翻訳に未対応のため、英語のまま入力しました（Chrome 最新版で日本語化されます）。');
          }
        } else {
          appendTo(which, text);
        }
      },
      onError: (m) => {
        if (m) setNotice(m);
      },
      onEnd: () => setListening(''),
    });
    recog.start();
  };

  const hasAny = String(dayNote).trim() || String(nightNote).trim();

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-slate-600">様子メモ（日中・夜勤）</div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-black">
            <button
              type="button"
              onClick={() => setVoiceLang('ja')}
              className={`rounded-md px-2 py-1 ${voiceLang === 'ja' ? 'bg-white text-teal-700 shadow' : 'text-slate-500'}`}
            >
              日本語
            </button>
            <button
              type="button"
              onClick={() => setVoiceLang('en')}
              className={`rounded-md px-2 py-1 ${voiceLang === 'en' ? 'bg-white text-teal-700 shadow' : 'text-slate-500'}`}
            >
              English
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          音声の言語を「English」にすると、英語で話した内容を日本語に変換して入力します。
        </p>

        <div className="mt-2 space-y-2">
          <NoteRow
            label="日中"
            value={dayNote}
            onChange={(v) => setDayNote(v.slice(0, NOTE_MAXLEN))}
            onPreset={(p) => appendTo('day', p)}
            voiceLang={voiceLang}
            onVoice={() => startVoice('day')}
            listening={listening === 'day'}
            speechOK={speechOK}
          />
          <NoteRow
            label="夜勤"
            value={nightNote}
            onChange={(v) => setNightNote(v.slice(0, NOTE_MAXLEN))}
            onPreset={(p) => appendTo('night', p)}
            voiceLang={voiceLang}
            onVoice={() => startVoice('night')}
            listening={listening === 'night'}
            speechOK={speechOK}
          />
        </div>

        {notice && (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{notice}</div>
        )}

        <div className="mt-3">
          <BigRecordButton busy={busy} onClick={() => onRecordNote({ dayNote, nightNote })}>
            {hasAny ? '様子を記録' : '記録（入力なし）'}
          </BigRecordButton>
        </div>
      </div>
    </div>
  );
}
