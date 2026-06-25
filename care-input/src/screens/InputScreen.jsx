import React, { useState } from 'react';
import { ChevronLeft, Check, Loader2, Activity, Utensils, Footprints, Toilet } from 'lucide-react';
import { sendOrQueue } from '../lib/queue.js';
import {
  buildVitalEvent,
  buildPatrolEvent,
  buildUrineEvent,
  buildStoolEvent,
  buildMealEvent,
  buildFluidEvent,
} from '../lib/events.js';

const TABS = [
  { key: 'vital', label: 'バイタル', icon: Activity },
  { key: 'meal', label: '食事・水分', icon: Utensils },
  { key: 'patrol', label: '巡視', icon: Footprints },
  { key: 'excretion', label: '排泄', icon: Toilet },
];

const WARI = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const URINE_CODES = ['トイレ', '尿器', '失禁', '少量', '中量', '多量', 'カテ'];
const URINE_NEEDS_ML = new Set(['カテ']);
const STOOL_VOLUME = ['少', '中', '多'];
const STOOL_CHARACTER = ['普通', '軟便', '硬便', '水様', '泥状'];
const MEAL_TIMES = ['朝', '昼', '夜', '間食'];

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

/** @param {{ resident: object; staffName: string; onBack: () => void }} props */
export function InputScreen({ resident, staffName, onBack }) {
  const [tab, setTab] = useState('vital');
  const [time, setTime] = useState(nowHHMM());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const record = async (events) => {
    if (busy) return;
    setBusy(true);
    setFlash('');
    try {
      const list = Array.isArray(events) ? events : [events];
      const { sent } = await sendOrQueue(list);
      setFlash(sent ? `記録しました（${time}）` : `保存しました（送信待ち・${time}）`);
      window.setTimeout(() => setFlash(''), 2500);
    } finally {
      setBusy(false);
    }
  };

  const ts = () => tsFromTime(time);

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

      <div className="mb-3 grid grid-cols-4 gap-1 rounded-xl bg-slate-200 p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
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
        <VitalPanel busy={busy} onRecord={(v) => record(buildVitalEvent(resident, v, staffName, ts()))} />
      )}
      {tab === 'meal' && (
        <MealPanel
          busy={busy}
          onRecordMeal={(v) => record(buildMealEvent(resident, v, staffName, ts()))}
          onRecordFluid={(v) => record(buildFluidEvent(resident, v, staffName, ts()))}
        />
      )}
      {tab === 'patrol' && (
        <PatrolPanel busy={busy} onRecord={() => record(buildPatrolEvent(resident, staffName, ts()))} />
      )}
      {tab === 'excretion' && (
        <ExcretionPanel
          busy={busy}
          onRecordUrine={(v) => record(buildUrineEvent(resident, v, staffName, ts()))}
          onRecordStool={(v) => record(buildStoolEvent(resident, v, staffName, ts()))}
        />
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

function VitalPanel({ busy, onRecord }) {
  const [v, setV] = useState({ temp: '', bpUpper: '', bpLower: '', pulse: '', spo2: '' });
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
      <BigRecordButton
        busy={busy}
        onClick={() => {
          onRecord(v);
          setV({ temp: '', bpUpper: '', bpLower: '', pulse: '', spo2: '' });
        }}
      >
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

function MealPanel({ busy, onRecordMeal, onRecordFluid }) {
  const [mealTime, setMealTime] = useState('');
  const [mealStaple, setMealStaple] = useState('');
  const [mealSide, setMealSide] = useState('');
  const [waterMl, setWaterMl] = useState('');

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
        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            onClick={() => {
              onRecordMeal({ mealTime, mealStaple, mealSide });
              setMealStaple('');
              setMealSide('');
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

function ExcretionPanel({ busy, onRecordUrine, onRecordStool }) {
  const [urineCode, setUrineCode] = useState('');
  const [urineMl, setUrineMl] = useState('');
  const [stoolVolume, setStoolVolume] = useState('');
  const [stoolCharacter, setStoolCharacter] = useState('');

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <div className="text-sm font-bold text-slate-600">排尿</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {URINE_CODES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setUrineCode(c)}
              className={`rounded-xl py-3 text-lg font-black ${
                urineCode === c ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        {URINE_NEEDS_ML.has(urineCode) && (
          <div className="mt-2">
            <NumField label="尿量" unit="ml" value={urineMl} onChange={setUrineMl} placeholder="200" />
          </div>
        )}
        <div className="mt-3">
          <BigRecordButton
            busy={busy}
            color="sky"
            onClick={() => {
              onRecordUrine({ urineCode, measuredUrineMl: urineMl });
              setUrineCode('');
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
