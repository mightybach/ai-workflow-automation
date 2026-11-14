import type { ReactNode } from 'react';

export interface Column<T> { key: string; heading: string; render(record: T): ReactNode }
interface Props<T> {
  records: T[];
  columns: Column<T>[];
  getId(record: T): string;
  getLabel(record: T): string;
  busy: boolean;
  caption: string;
  onView(record: T): void;
  onEdit?(record: T): void;
  onDelete?(record: T): void;
}
export function CrudTable<T>({ records, columns, getId, getLabel, busy, caption, onView, onEdit, onDelete }: Props<T>) {
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map((column) => <th scope="col" key={column.key}>{column.heading}</th>)}<th scope="col">Actions</th></tr></thead>
        <tbody>{records.map((record) => (
          <tr key={getId(record)}>
            {columns.map((column) => <td key={column.key}>{column.render(record)}</td>)}
            <td><div className="row-actions">
              <button className="secondary" disabled={busy} aria-label={'View ' + getLabel(record)} onClick={() => onView(record)}>View</button>
              {onEdit && <button className="secondary" disabled={busy} aria-label={'Edit ' + getLabel(record)} onClick={() => onEdit(record)}>Edit</button>}
              {onDelete && <button className="danger" disabled={busy} aria-label={'Delete ' + getLabel(record)} onClick={() => onDelete(record)}>Delete</button>}
            </div></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

