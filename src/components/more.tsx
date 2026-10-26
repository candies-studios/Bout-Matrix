import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui';
import { cx } from '@/lib/cx';

/** Accessible modal built on <dialog> (focus trap, Esc to close). */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="modal-title"
      className={cx('m-auto w-[calc(100%-2rem)] rounded-lg border border-ink-700 bg-ink-900 p-0 text-ink-100 backdrop:bg-black/70', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      {open && (
        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="modal-title" className="text-2xl font-bold uppercase">
              {title}
            </h2>
            <button onClick={onClose} className="rounded px-2 text-2xl leading-none text-ink-400 hover:text-ink-100" aria-label="Close">
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-700">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm [&_td]:border-t [&_td]:border-ink-700 [&_td]:px-3 [&_td]:py-2.5 [&_th]:bg-ink-850 [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-ink-400 [&_tbody_tr:hover]:bg-ink-850">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-sm text-ink-400">
      <span>
        {total === 0 ? 'No results' : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} of ${total}`}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-ink-700">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold', value === o.value ? 'border-accent-500 text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-100')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          window.prompt('Copy this link:', text);
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Checkbox({ label, checked, onChange, id, description }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; id: string; description?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5 accent-accent-600" />
      <label htmlFor={id} className="text-sm text-ink-300">
        {label}
        {description && <span className="block text-xs text-ink-400">{description}</span>}
      </label>
    </div>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{k}</dt>
          <dd className="mt-0.5 text-ink-100">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold uppercase">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
