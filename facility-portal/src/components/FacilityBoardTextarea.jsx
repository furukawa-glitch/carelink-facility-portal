import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

/**
 * 施設掲示板用テキストエリア。親（RecordPage 等）の再描画を避け、入力を軽くする。
 */
export const FacilityBoardTextarea = memo(function FacilityBoardTextarea({
  syncKey = '',
  externalRevision = 0,
  initialValue = '',
  onSave,
  rows = 4,
  placeholder = '',
  className = '',
  saveButtonClassName = 'mt-2 w-full rounded-lg bg-amber-600 px-3 py-2 text-sm font-black text-white hover:bg-amber-500',
  saveLabel = '保存',
  onEditingChange,
}) {
  const [value, setValue] = useState(initialValue);
  const [saveFlash, setSaveFlash] = useState(false);
  const dirtyRef = useRef(false);
  const syncKeyRef = useRef(syncKey);

  useEffect(() => {
    if (syncKey !== syncKeyRef.current) {
      syncKeyRef.current = syncKey;
      dirtyRef.current = false;
      setValue(initialValue);
      return;
    }
    if (dirtyRef.current) return;
    setValue(initialValue);
  }, [syncKey, initialValue, externalRevision]);

  const handleChange = useCallback((e) => {
    dirtyRef.current = true;
    setValue(e.target.value);
  }, []);

  const handleFocus = useCallback(() => {
    dirtyRef.current = true;
    onEditingChange?.(true);
  }, [onEditingChange]);

  const handleBlur = useCallback(() => {
    onEditingChange?.(false);
  }, [onEditingChange]);

  const handleSave = useCallback(() => {
    onSave?.(value);
    dirtyRef.current = false;
    setSaveFlash(true);
    window.setTimeout(() => setSaveFlash(false), 1500);
  }, [onSave, value]);

  return (
    <>
      <textarea
        value={value}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
        rows={rows}
        placeholder={placeholder}
        className={className}
      />
      <button type="button" onClick={handleSave} className={saveButtonClassName}>
        {saveFlash ? '保存しました' : saveLabel}
      </button>
    </>
  );
});
