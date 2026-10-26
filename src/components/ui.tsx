import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

import { cx } from '@/lib/cx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-accent-600 hover:bg-accent-500 text-white border-transparent',
  secondary: 'bg-ink-800 hover:bg-ink-700 text-ink-100 border-ink-700',
  ghost: 'bg-transparent hover:bg-ink-800 text-ink-300 border-transparent',
  danger: 'bg-transparent hover:bg-accent-700/20 text-accent-400 border-accent-700',
};

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small, label = 'Loading' }: { small?: boolean; label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex">
      <span
        className={cx(
          'inline-block animate-spin rounded-full border-2 border-ink-600 border-t-ink-100',
          small ? 'h-4 w-4' : 'h-6 w-6',
        )}
      />
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-ink-700 bg-ink-900 p-5', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-3xl font-bold uppercase text-ink-100">{title}</h1>
        {description && <p className="mt-1 text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  neutral: 'bg-ink-800 text-ink-300 border-ink-700',
  ok: 'bg-green-950/60 text-green-300 border-green-900',
  warn: 'bg-amber-950/60 text-amber-300 border-amber-900',
  danger: 'bg-red-950/60 text-red-300 border-red-900',
  info: 'bg-sky-950/60 text-sky-300 border-sky-900',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'danger', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-md border px-4 py-3 text-sm', tones[tone])}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 px-6 py-12 text-center">
      <p className="font-display text-xl uppercase text-ink-300">{title}</p>
      {children && <div className="mt-2 text-ink-400">{children}</div>}
    </div>
  );
}

interface FieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

/** Accessible label + hint + error wrapper. */
export function Field({ label, required, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-300">
        {label}
        {required && (
          <span className="ml-0.5 text-accent-400" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children({ id, describedBy: [hintId, errId].filter(Boolean).join(' ') || undefined, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-ink-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-sm text-accent-400">
          {error}
        </p>
      )}
    </div>
  );
}

const inputBase =
  'min-h-11 w-full rounded-md border bg-ink-800 px-3 py-2 text-base text-ink-100 placeholder:text-ink-400 ' +
  'border-ink-700 focus:border-ink-400 aria-[invalid=true]:border-accent-500';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputBase, props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputBase, props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputBase, 'min-h-24', props.className)} />;
}
