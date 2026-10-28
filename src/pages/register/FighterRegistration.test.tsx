import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

const registered: unknown[] = [];
vi.mock('@/lib/supabase', () => ({
  configError: null,
  siteUrl: 'https://x.example',
  friendlyError: (e: unknown) => String(e),
  supabase: {
    rpc: (name: string, args?: unknown) =>
      Promise.resolve({
        data:
          name === 'public_register_fighter'
            ? (registered.push(args), { status: 'created', fighter_code: 'WDS-F-0259', event_name: 'Demo Night', registration_status: 'submitted' })
            : name === 'public_registration_event'
            ? [{ slug: 'demo', name: 'Demo Night', starts_at: null, venue_name: null, venue_city: null, registration_open: true, registration_closes_at: null, divisions: ['men'], competition_levels: ['amateur'], required_documents: [], weight_classes: [] }]
            : [],
        error: null,
      }),
  },
}));

afterEach(cleanup);

async function renderForm() {
  const { FighterRegistration } = await import('./FighterRegistration');
  const router = createMemoryRouter([{ path: '/register/fighter', element: <FighterRegistration /> }], { initialEntries: ['/register/fighter?event=demo'] });
  render(<RouterProvider router={router} />);
  await waitFor(() => screen.getByText('Submit registration'));
}

describe('fighter registration form', () => {
  it('has one mandatory Nickname box and no separate fight-name or skill-level fields', async () => {
    await renderForm();
    expect(screen.getByLabelText(/^Nickname/)).toBeRequired();
    expect(screen.queryByLabelText(/Public fight name/)).toBeNull();
    expect(screen.queryByLabelText(/Skill level/)).toBeNull();
  });

  it('asks for weight in kg only', async () => {
    await renderForm();
    expect(screen.getByLabelText(/Current weight \(kg\)/)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'lb' })).toBeNull();
  });

  it('shows the reach hint, the style dropdown and the renamed experience box', async () => {
    await renderForm();
    expect(screen.getByText('Fingertip-to-fingertip distance')).toBeInTheDocument();
    const style = screen.getByLabelText('Primary fighting style') as HTMLSelectElement;
    expect([...style.options].map((o) => o.text)).toEqual([
      'Choose…', 'Boxing', 'Muay Thai (Thai Boxing)', 'Brazilian Jiu-Jitsu (BJJ)', 'Kickboxing', 'Wrestling', 'Taekwondo', 'Karate', 'Judo',
    ]);
    expect(screen.getByLabelText('Previous competition experience & winning titles (if any)')).toBeInTheDocument();
  });

  it('attach button opens the file picker and shows / removes the chosen photo', async () => {
    await renderForm();
    const input = screen.getByLabelText('Profile photo') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: /Attach file/ }));
    expect(click).toHaveBeenCalled();
    globalThis.URL.createObjectURL ??= () => 'blob:x';
    globalThis.URL.revokeObjectURL ??= () => {};
    fireEvent.change(input, { target: { files: [new File(['x'], 'me.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText('me.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove me.jpg' }));
    expect(screen.getByText('No file chosen')).toBeInTheDocument();
  });
});

describe('submitting the form', () => {
  it('saves the registration and shows the thank-you page with the registration ID', async () => {
    const { FighterRegistration } = await import('./FighterRegistration');
    const { RegisterSuccess } = await import('./RegisterSuccess');
    const router = createMemoryRouter(
      [{ path: '/register/fighter', element: <FighterRegistration /> }, { path: '/register/success', element: <RegisterSuccess /> }],
      { initialEntries: ['/register/fighter?event=demo'] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => screen.getByText('Submit registration'));
    const type = (label: RegExp, value: string) => fireEvent.change(screen.getAllByLabelText(label)[0], { target: { value } });
    type(/^Full legal name/, 'Ravi Kumar');
    type(/^Nickname/, 'Ravi');
    type(/^Date of birth/, '2001-05-04');
    type(/^Email/, 'ravi@example.com');
    type(/^Code/, '+91');
    type(/^Phone/, '9876543210');
    type(/^City/, 'Pune');
    type(/^Country/, 'India');
    fireEvent.change(screen.getByLabelText(/^Division/), { target: { value: 'men' } });
    fireEvent.change(screen.getByLabelText(/^Competition level/), { target: { value: 'amateur' } });
    type(/^Current weight/, '70.5');
    for (const l of [/^Wins/, /^Losses/, /^Draws/, /^No contests/]) type(l, '0');
    type(/^Gym name/, 'Independent');
    for (const box of screen.getAllByRole('checkbox')) if (box.id.startsWith('consent')) fireEvent.click(box);
    fireEvent.click(screen.getByText('Submit registration'));
    await waitFor(() => screen.getByText('Thank you for registering!'), { timeout: 4000 });
    expect(screen.getByText('WDS-F-0259')).toBeInTheDocument();
    expect(screen.getByText('Your registration ID')).toBeInTheDocument();
    expect(registered).toHaveLength(1);
  });
});
