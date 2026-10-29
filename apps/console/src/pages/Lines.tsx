import { useMemo, useState } from 'react';
import type { Device, Line, RoutingMode } from '@telno/shared';
import { DEVICE_MODELS } from '@telno/shared';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  SkeletonRows,
  useAsync,
  useToast,
} from '../ui';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MODE_LABEL: Record<RoutingMode, string> = {
  'business-hours': 'Business hours',
  always: 'Always answer',
  forward: 'Forward',
  voicemail: 'Voicemail',
};

const MODE_HELP: Record<RoutingMode, string> = {
  'business-hours': 'Answer inside the window, then forward or reject outside it.',
  always: 'Answer every call to this line, any hour.',
  forward: 'Hand every call to another address immediately.',
  voicemail: 'Send every call to the platform voicemail address.',
};

export function LinesPage() {
  const lines = useAsync<{ lines: Line[] }>(() => api.lines(), []);
  const devices = useAsync<{ devices: Device[] }>(() => api.devices(), []);
  const [editing, setEditing] = useState<Line | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Line | null>(null);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const deviceName = (id: string | null) => {
    if (!id) return '—';
    const device = devices.data?.devices.find((d) => d.id === id);
    return device ? device.label : 'unassigned';
  };

  const refresh = () => {
    lines.reload();
    devices.reload();
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteLine(deleting.id);
      push(`Line ${deleting.extension} deleted`, 'ok');
      setDeleting(null);
      refresh();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not delete the line', 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (line: Line) => {
    try {
      await api.updateLine(line.id, { enabled: !line.enabled });
      refresh();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not update the line', 'err');
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Extensions</h2>
          <span className="hint">{lines.data?.lines.length ?? 0} lines</span>
          <div className="spacer" />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            Add line
          </Button>
        </div>

        {lines.loading && !lines.data ? (
          <SkeletonRows rows={4} />
        ) : lines.error ? (
          <div className="card-body">
            <ErrorBox message={lines.error} onRetry={lines.reload} />
          </div>
        ) : (lines.data?.lines.length ?? 0) === 0 ? (
          <EmptyState
            title="No lines configured"
            message="A line gives a device an address of record and a routing rule."
            action={
              <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
                Add the first line
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ext</th>
                  <th>Address</th>
                  <th>Device</th>
                  <th>Routing</th>
                  <th>Forward to</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(lines.data?.lines ?? []).map((line) => (
                  <tr key={line.id}>
                    <td className="mono strong">{line.extension}</td>
                    <td>
                      <div className="strong">{line.displayName}</div>
                      <div className="mono muted small">{line.aor}</div>
                    </td>
                    <td className="small">{deviceName(line.deviceId)}</td>
                    <td>
                      <Badge tone={line.routingMode === 'always' ? 'ok' : 'accent'}>
                        {MODE_LABEL[line.routingMode]}
                      </Badge>
                      {line.routingMode === 'business-hours' ? (
                        <div className="muted small mono">
                          {line.businessHours.start}–{line.businessHours.end}
                        </div>
                      ) : null}
                    </td>
                    <td className="mono small">{line.forwardTo ?? '—'}</td>
                    <td>
                      <button className="chip" aria-pressed={line.enabled} onClick={() => toggle(line)}>
                        {line.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(line)} />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() => setDeleting(line)}
                          aria-label={`Delete line ${line.extension}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing ? (
        <LineModal
          line={editing === 'new' ? null : editing}
          devices={devices.data?.devices ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete line ${deleting.extension}?`}
          message="Devices lose this account on their next configuration poll. The address of record will be free for reuse."
          confirmLabel="Delete line"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={remove}
        />
      ) : null}
    </>
  );
}

function LineModal({
  line,
  devices,
  onClose,
  onSaved,
}: {
  line: Line | null;
  devices: Device[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [extension, setExtension] = useState(line?.extension ?? '');
  const [displayName, setDisplayName] = useState(line?.displayName ?? '');
  const [aorName, setAorName] = useState(line ? line.aor.split('@')[0] ?? '' : '');
  const [deviceId, setDeviceId] = useState(line?.deviceId ?? '');
  const [accountSlot, setAccountSlot] = useState(String(line?.accountSlot ?? 1));
  const [routingMode, setRoutingMode] = useState<RoutingMode>(line?.routingMode ?? 'business-hours');
  const [forwardTo, setForwardTo] = useState(line?.forwardTo ?? '');
  const [start, setStart] = useState(line?.businessHours.start ?? '09:00');
  const [end, setEnd] = useState(line?.businessHours.end ?? '17:00');
  const [days, setDays] = useState<string[]>(
    line?.businessHours.weekdays ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
  );
  const [enabled, setEnabled] = useState(line?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const slots = useMemo(() => {
    const device = devices.find((d) => d.id === deviceId);
    const count = device ? DEVICE_MODELS[device.model].accountSlots : 6;
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [deviceId, devices]);

  const submit = async () => {
    setBusy(true);
    const payload = {
      extension: extension.trim(),
      displayName: displayName.trim(),
      aorName: aorName.trim() || undefined,
      deviceId: deviceId || null,
      accountSlot: Number(accountSlot),
      routingMode,
      forwardTo: forwardTo.trim() || null,
      businessHours: { start, end, weekdays: days },
      enabled,
    };
    try {
      if (line) await api.updateLine(line.id, payload);
      else await api.createLine(payload);
      push(line ? 'Line updated' : 'Line created', 'ok');
      onSaved();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not save the line', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={line ? `Edit line ${line.extension}` : 'Add a line'}
      subtitle="An address of record plus the cantus routing that answers it"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!extension.trim() || !displayName.trim()}
            onClick={submit}
          >
            {line ? 'Save changes' : 'Create line'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Extension" help="2–6 digits">
          <input
            className="input mono"
            value={extension}
            placeholder="101"
            autoFocus
            onChange={(e) => setExtension(e.target.value)}
          />
        </Field>
        <Field label="Display name">
          <input
            className="input"
            value={displayName}
            placeholder="Reception"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Address name" help="Left blank, it is derived from the display name">
          <input
            className="input mono"
            value={aorName}
            placeholder="reception"
            onChange={(e) => setAorName(e.target.value)}
          />
        </Field>
        <Field label="Device">
          <select className="select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Unassigned</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label} — {DEVICE_MODELS[device.model].name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Account slot" help="Which account on the device holds this line">
          <select
            className="select"
            value={accountSlot}
            onChange={(e) => setAccountSlot(e.target.value)}
          >
            {slots.map((slot) => (
              <option key={slot} value={slot}>
                Slot {slot}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Routing mode">
          <select
            className="select"
            value={routingMode}
            onChange={(e) => setRoutingMode(e.target.value as RoutingMode)}
          >
            {(Object.keys(MODE_LABEL) as RoutingMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="callout">
        <strong>{MODE_LABEL[routingMode]}</strong>
        <span>{MODE_HELP[routingMode]}</span>
      </div>

      {routingMode === 'business-hours' ? (
        <div className="stack">
          <div className="form-grid">
            <Field label="Opens">
              <input
                className="input"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Closes">
              <input
                className="input"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <div className="field">
            <label>Open days</label>
            <div className="tag-input">
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  className="chip"
                  aria-pressed={days.includes(day)}
                  onClick={() =>
                    setDays((current) =>
                      current.includes(day)
                        ? current.filter((d) => d !== day)
                        : [...current, day],
                    )
                  }
                >
                  {day}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {routingMode !== 'always' && routingMode !== 'voicemail' ? (
        <Field
          label={routingMode === 'business-hours' ? 'Outside hours, forward to' : 'Forward to'}
          help="An address of record such as voicemail@telno.local. Leave blank to reject as unavailable."
        >
          <input
            className="input mono"
            value={forwardTo}
            placeholder="voicemail@telno.local"
            onChange={(e) => setForwardTo(e.target.value)}
          />
        </Field>
      ) : null}

      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Line is enabled and included in the routing document
      </label>
    </Modal>
  );
}
