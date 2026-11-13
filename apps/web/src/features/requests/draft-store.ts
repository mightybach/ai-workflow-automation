import type { CrudStore } from '../../lib/crud';

// These fields exist only for the UI demonstration. They do not define a persisted request.
export interface DraftInput { title: string; message: string }
export interface RequestDraft extends DraftInput { id: string }

export function createDraftStore(): CrudStore<RequestDraft, DraftInput> {
  const records = new Map<string, RequestDraft>();
  function read(id: string) {
    const record = records.get(id);
    if (!record) throw new Error('This draft no longer exists. Refresh the list.');
    return { ...record };
  }
  function validate(input: DraftInput): DraftInput {
    const title = input.title.trim();
    const message = input.message.trim();
    if (!title || !message) throw new Error('Enter a title and message.');
    if (title.length > 120 || message.length > 10000) throw new Error('The title or message is too long.');
    return { title, message };
  }
  return {
    async list() { return Array.from(records.values(), (record) => ({ ...record })); },
    async read(id) { return read(id); },
    async create(input) {
      const record = { ...validate(input), id: crypto.randomUUID() };
      records.set(record.id, record);
      return { ...record };
    },
    async update(id, input) {
      read(id);
      const record = { ...validate(input), id };
      records.set(id, record);
      return { ...record };
    },
    async delete(id) { read(id); records.delete(id); },
  };
}

