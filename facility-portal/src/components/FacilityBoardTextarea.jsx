import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

/**
 * 施設掲示板用テキストエリア。親（RecordPage 等）の再描画を避け、入力を軽くする。
 * 日本語 IME 変換中は React の controlled 更新を避け、変換確定後も親の再描画に巻き込まれないよう
 * 入力中は ref ベース（非制御）で保持する。
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
  const textareaRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const dirtyRef = useRef(false);
  const composingRef = useRef(false);
  const syncKeyRef = useRef(syncKey);
  const [saveFlash, setSaveFlash] = useState(false);

  const readValue = useCallback(() => String(textareaRef.current?.value ?? ''), []);

  useEffect(() => {
    if (syncKey !== syncKeyRef.current) {
      syncKeyRef.current = syncKey;
      dirtyRef.current = false;
      if (textareaRef.current) textareaRef.current.value = initialValue;
      return;
    }
    if (dirtyRef.current || composingRef.current) return;
    if (textareaRef.current && textareaRef.current.value !== initialValue) {
      textareaRef.current.value = initialValue;
    }
  }, [syncKey, initialValue, externalRevision]);

  const handleFocus = useCallback(() => {
    dirtyRef.current = true;
    onEditingChange?.(true);
  }, [onEditingChange]);

  const handleBlur = useCallback(() => {
    onEditingChange?.(false);
  }, [onEditingChange]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    dirtyRef.current = true;
    onEditingChange?.(true);
  }, [onEditingChange]);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    dirtyRef.current = true;
  }, []);

  const handleSave = useCallback(() => {
    const v = readValue();
    onSave?.(v);
    dirtyRef.current = false;
    setSaveFlash(true);
    window.setTimeout(() => setSaveFlash(false), 1500);
  }, [onSave, readValue]);

  return (
    <>
      <textarea
        ref={textareaRef}
        defaultValue={initialValue}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onChange={() => {
          dirtyRef.current = true;
        }}
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
