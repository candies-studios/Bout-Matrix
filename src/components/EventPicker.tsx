import { Select } from './ui';

export function EventPicker({ eventId, setEventId, events }: { eventId: string; setEventId: (id: string) => void; events: { id: string; name: string; status: string }[] }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-400">
      Event
      <Select value={eventId} onChange={(e) => setEventId(e.target.value)} className="min-w-64">
        {events.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.status.replace(/_/g, ' ')})
          </option>
        ))}
      </Select>
    </label>
  );
}
