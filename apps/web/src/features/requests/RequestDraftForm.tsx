import { useId, useState, type FormEvent } from 'react';
import type { DraftInput, RequestDraft } from './draft-store';

export function RequestDraftForm({ record, busy, onSave, onCancel }: {
  record: RequestDraft | null; busy: boolean;
  onSave(input: DraftInput): Promise<void>; onCancel(): void;
}) {
  const id = useId();
  const [title, setTitle] = useState(record?.title ?? '');
  const [message, setMessage] = useState(record?.message ?? '');
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !message.trim()) { setError('Enter a title and message.'); return; }
    setError('');
    void onSave({ title: title.trim(), message: message.trim() });
  }
  return (
    <section aria-labelledby={id + '-heading'}>
      <h3 id={id + '-heading'}>{record ? 'Edit draft' : 'Create draft'}</h3>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend className="sr-only">Synthetic request draft</legend>
          <label htmlFor={id + '-title'}>Title</label>
          <input id={id + '-title'} required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor={id + '-message'}>Request message</label>
          <textarea id={id + '-message'} required maxLength={10000} rows={5} value={message} onChange={(event) => setMessage(event.target.value)} aria-describedby={id + '-hint'} />
          <p id={id + '-hint'} className="note">Use made-up details only. This draft stays in memory until the page is refreshed.</p>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="row-actions">
            <button type="submit">{busy ? 'Saving…' : record ? 'Save changes' : 'Create draft'}</button>
            <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}

