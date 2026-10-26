import { CopyButton } from './more';
import { Button } from './ui';

export function ShareButtons({ url, text }: { url: string; text: string }) {
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  return (
    <div className="flex flex-wrap gap-2">
      {canShare && (
        <Button variant="secondary" onClick={() => void navigator.share({ title: text, url }).catch(() => undefined)}>
          Share
        </Button>
      )}
      <a
        className="inline-flex min-h-11 items-center rounded-md border border-ink-700 bg-ink-800 px-4 text-sm font-semibold hover:bg-ink-700"
        href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        WhatsApp
      </a>
      <a
        className="inline-flex min-h-11 items-center rounded-md border border-ink-700 bg-ink-800 px-4 text-sm font-semibold hover:bg-ink-700"
        href={`mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}`}
      >
        Email
      </a>
      <CopyButton text={url} label="Copy link" />
    </div>
  );
}
