import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import './index.css';
import { AuthProvider } from '@/lib/auth';
import { configError } from '@/lib/supabase';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (configError) {
    root.render(
      <div className="mx-auto max-w-xl px-4 py-20">
        <h1 className="text-3xl font-bold uppercase">Setup required</h1>
        <p className="mt-3 text-ink-300">{configError}</p>
      </div>,
    );
    return;
  }
  const { router } = await import('./router');
  root.render(
    <StrictMode>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </StrictMode>,
  );
}

void start();
