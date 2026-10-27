import { useEffect, useMemo, useRef } from 'react';
import { cx } from '@/lib/cx';

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  id: string;
  accept: string;
  file: File | null;
  onChange: (file: File | null) => void;
  describedBy?: string;
  invalid?: boolean;
  /** Show a small thumbnail for images. */
  preview?: boolean;
}

/**
 * "Attach" button with a paperclip: clicking it opens the device's file browser (folders / photos).
 * Shows the chosen file's name and size, an optional thumbnail, and lets the user change or remove it.
 */
export function AttachFile({ id, accept, file, onChange, describedBy, invalid, preview }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const thumb = useMemo(
    () => (preview && file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null),
    [file, preview],
  );
  useEffect(() => () => {
    if (thumb) URL.revokeObjectURL(thumb);
  }, [thumb]);

  return (
    <div className="flex flex-col gap-2">
      {/* The real file input stays in the DOM (for accessibility and form behaviour) but is visually hidden. */}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        aria-describedby={describedBy}
        aria-invalid={invalid}
        onChange={(e) => {
          onChange(e.target.files?.[0] ?? null);
          e.target.value = ''; // allow choosing the same file again after removing it
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          aria-controls={id}
          className={cx(
            'inline-flex min-h-11 items-center gap-2 rounded-md border bg-ink-800 px-4 py-2 text-sm font-semibold text-ink-100 hover:bg-ink-700',
            invalid ? 'border-accent-500' : 'border-ink-700',
          )}
        >
          <PaperclipIcon />
          {file ? 'Change file' : 'Attach file'}
        </button>
        {file && (
          <div className="flex min-w-0 items-center gap-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
            {thumb && <img src={thumb} alt="Selected photo preview" className="h-10 w-10 shrink-0 rounded object-cover" />}
            <span className="min-w-0 text-sm">
              <span className="block max-w-[14rem] truncate text-ink-100" title={file.name}>
                {file.name}
              </span>
              <span className="text-xs text-ink-400">{formatSize(file.size)}</span>
            </span>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="ml-1 rounded px-2 text-lg leading-none text-ink-400 hover:text-accent-400"
              aria-label={`Remove ${file.name}`}
            >
              ×
            </button>
          </div>
        )}
        {!file && <span className="text-sm text-ink-400">No file chosen</span>}
      </div>
    </div>
  );
}
