import { useEffect } from 'react';

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Page title + description + Open Graph/Twitter tags for sharing. */
export function useSeo(title: string | undefined, description?: string, image?: string | null) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} | Fight Night`;
    const desc = description ?? 'Fight cards, events and registration.';
    setMeta('name', 'description', desc);
    setMeta('property', 'og:title', title);
    setMeta('property', 'og:description', desc);
    setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:url', window.location.href);
    setMeta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
    if (image) setMeta('property', 'og:image', image);
  }, [title, description, image]);
}
