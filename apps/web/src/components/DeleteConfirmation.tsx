import { useEffect, useId, useRef } from 'react';

export function DeleteConfirmation({ label, busy, error, onCancel, onConfirm }: {
  label: string | null; busy: boolean; error: string;
  onCancel(): void; onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (label !== null && !dialog.current?.open) dialog.current?.showModal();
    if (label === null && dialog.current?.open) dialog.current.close();
  }, [label]);
  return (
    <dialog ref={dialog} aria-labelledby={headingId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id={headingId}>Delete draft?</h2>
      <p id={descriptionId}>Delete “{label}” from this preview? This cannot be undone.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row-actions">
        <button className="secondary" autoFocus disabled={busy} onClick={onCancel}>Keep draft</button>
        <button className="danger" disabled={busy} onClick={onConfirm}>{busy ? 'Deleting…' : 'Delete draft'}</button>
      </div>
    </dialog>
  );
}

