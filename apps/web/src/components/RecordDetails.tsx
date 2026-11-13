import { useId, type ReactNode } from 'react';

export function RecordDetails({ title, fields, onClose, busy }: {
  title: string;
  fields: { label: string; value: ReactNode }[];
  onClose(): void;
  busy: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="section-heading"><h3 id={headingId}>{title}</h3><button className="secondary" disabled={busy} onClick={onClose}>Close details</button></div>
      <dl>{fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
    </section>
  );
}

