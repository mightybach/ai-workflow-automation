import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrudStore } from '../../lib/crud';
import { CrudTable } from '../../components/CrudTable';
import { RecordDetails } from '../../components/RecordDetails';
import { DeleteConfirmation } from '../../components/DeleteConfirmation';
import { RequestDraftForm } from './RequestDraftForm';
import type { DraftInput, RequestDraft } from './draft-store';

const PAGE_SIZE = 5;
type Editor = { record: RequestDraft | null };
export function RequestWorkspace({ store }: { store: CrudStore<RequestDraft, DraftInput> }) {
  const [records, setRecords] = useState<RequestDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selected, setSelected] = useState<RequestDraft | null>(null);
  const [deleting, setDeleting] = useState<RequestDraft | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const locked = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await store.list();
      if (generation.current === current) { setRecords(result); setError(''); }
    } catch {
      if (generation.current === current) setError('Could not load drafts. Try refreshing the list.');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The action failed. Please try again.'); }
    finally { locked.current = false; setBusy(false); }
  }

  const filtered = records.filter((record) =>
    (record.title + ' ' + record.message).toLowerCase().includes(search.toLowerCase()));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function save(input: DraftInput) {
    if (!editor) return;
    await perform(async () => {
      const saved = editor.record ? await store.update(editor.record.id, input) : await store.create(input);
      setSelected(saved); setEditor(null); setSearch(''); setPage(1);
      setNotice(editor.record ? 'Draft updated.' : 'Draft created.');
      await refresh();
    });
  }

  return (
    <section aria-labelledby="requests-heading" aria-busy={loading || busy}>
      <div className="section-heading">
        <div><span className="badge">Phase 1 / UI preview</span><h2 id="requests-heading">Request drafts</h2></div>
        <button disabled={busy || loading} onClick={() => { setEditor({ record: null }); setSelected(null); setError(''); }}>New draft</button>
      </div>
      <p className="note">In-memory preview. Drafts disappear on page refresh and are never submitted for processing.</p>
      <div className="toolbar">
        <label htmlFor="draft-search">Search drafts</label>
        <input id="draft-search" type="search" value={search} disabled={busy} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        <button className="secondary" disabled={busy || loading} onClick={() => { void refresh(); }}>Refresh list</button>
      </div>
      {notice && <p role="status" className="success">{notice}</p>}
      {error && !deleting && <p role="alert" className="error">{error}</p>}
      {loading ? <p role="status">Loading drafts…</p> : filtered.length === 0 ? (
        <p>{search ? 'No drafts match your search.' : 'No drafts yet. Create a synthetic request to try the preview.'}</p>
      ) : (
        <>
          <CrudTable caption="Synthetic request drafts and available actions" records={visible} columns={[
            { key: 'title', heading: 'Title', render: (record) => record.title },
            { key: 'message', heading: 'Message', render: (record) => <span className="preview-text">{record.message}</span> },
          ]} getId={(record) => record.id} getLabel={(record) => record.title} busy={busy}
            onView={(record) => { void perform(async () => { setSelected(await store.read(record.id)); setEditor(null); }); }}
            onEdit={(record) => { void perform(async () => { setEditor({ record: await store.read(record.id) }); setSelected(null); }); }}
            onDelete={(record) => { setDeleting(record); setError(''); }} />
          <nav className="pagination" aria-label="Draft pages">
            <button className="secondary" disabled={busy || currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
            <span>Page {currentPage} of {totalPages} · {filtered.length} drafts</span>
            <button className="secondary" disabled={busy || currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
          </nav>
        </>
      )}
      {editor && <RequestDraftForm key={editor.record?.id ?? 'new'} record={editor.record} busy={busy} onSave={save} onCancel={() => setEditor(null)} />}
      {selected && !editor && <RecordDetails title="Draft details" fields={[
        { label: 'Title', value: selected.title }, { label: 'Message', value: selected.message },
      ]} busy={busy} onClose={() => setSelected(null)} />}
      <DeleteConfirmation label={deleting?.title ?? null} busy={busy} error={error}
        onCancel={() => { setDeleting(null); setError(''); }}
        onConfirm={() => {
          if (!deleting) return;
          void perform(async () => {
            await store.delete(deleting.id);
            if (selected?.id === deleting.id) setSelected(null);
            if (editor?.record?.id === deleting.id) setEditor(null);
            setDeleting(null); setNotice('Draft deleted.');
            await refresh();
          });
        }} />
    </section>
  );
}

