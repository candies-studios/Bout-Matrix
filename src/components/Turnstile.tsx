import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id?: string) => void };
  }
}

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

/** Cloudflare Turnstile spam check — rendered only when VITE_TURNSTILE_SITE_KEY is configured. */
export function Turnstile({ onToken }: { onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!SITE_KEY || !ref.current) return;
    const el = ref.current;
    const render = () => window.turnstile?.render(el, { sitekey: SITE_KEY, theme: 'dark', callback: onToken });
    if (window.turnstile) render();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }
  }, [onToken]);
  return SITE_KEY ? <div ref={ref} className="min-h-16" /> : null;
}
