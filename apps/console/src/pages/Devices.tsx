import { useMemo, useState, type FormEvent } from 'react';
import type { AdaptorAccount, AdaptorOverview, Device, DeviceConfig, Line, ModelKey } from '@telno/shared';
import { DEVICE_MODELS, MODEL_KEYS, extensionProblem } from '@telno/shared';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Copyable,
  EmptyState,
  ErrorBox,
  Field,
  Icon,
  Modal,
  SkeletonRows,
  StatusBadge,
  formatDate,
  timeAgo,
  useAsync,
  useToast,
} from '../ui';

type Filter = 'all' | 'online' | 'pending' | 'offline';

export function DevicesPage() {
  const devices = useAsync<{ devices: Device[] }>(() => api.devices(), []);
  const lines = useAsync<{ lines: Line[] }>(() => api.lines(), []);
  const { push } = useToast();

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    devices.reload();
    lines.reload();
  };

  const list = useMemo(() => {
    const all = devices.data?.devices ?? [];
    const term = query.trim().toLowerCase();
    return all.filter((device) => {
      if (filter !== 'all' && device.status !== filter) return false;
      if (!term) return true;
      return `${device.label} ${device.serial} ${device.location} ${device.mac ?? ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [devices.data, filter, query]);

  const counts = useMemo(() => {
    const all = devices.data?.devices ?? [];
    return {
      all: all.length,
      online: all.filter((d) => d.status === 'online').length,
      pending: all.filter((d) => d.status === 'pending').length,
      offline: all.filter((d) => d.status === 'offline').length,
    };
  }, [devices.data]);

  const linesFor = (deviceId: string) => (lines.data?.lines ?? []).filter((l) => l.deviceId === deviceId);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteDevice(deleting.id);
      push(`Removed ${deleting.label}`, 'ok');
      setDeleting(null);
      setSelected(null);
      refresh();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not remove the device', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Fleet</h2>
          <span className="hint">{counts.all} registered</span>
          <div className="spacer" />
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Search label, serial, MAC…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            Add device
          </Button>
        </div>

        <div className="card-head" style={{ borderBottom: 'none', paddingTop: 0 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {(['all', 'online', 'pending', 'offline'] as Filter[]).map((key) => (
              <button
                key={key}
                className="chip"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key === 'all' ? 'All' : key} · {counts[key]}
              </button>
            ))}
          </div>
        </div>

        {devices.loading && !devices.data ? (
          <SkeletonRows rows={5} />
        ) : devices.error ? (
          <div className="card-body">
            <ErrorBox message={devices.error} onRetry={devices.reload} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            title={query ? 'No device matches that search' : 'No devices yet'}
            message={
              query
                ? 'Try a serial fragment or clear the filter.'
                : 'Add the hardware and give the owner an enrollment code.'
            }
            action={
              !query ? (
                <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
                  Add device
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Config</th>
                  <th>Lines</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((device) => {
                  const assigned = linesFor(device.id);
                  const behind =
                    device.appliedVersion !== null && device.appliedVersion < device.configVersion;
                  return (
                    <tr key={device.id}>
                      <td>
                        <button
                          className="btn ghost"
                          style={{ padding: 0, height: 'auto' }}
                          onClick={() => setSelected(device)}
                        >
                          <span style={{ display: 'grid', textAlign: 'left' }}>
                            <span className="strong">{device.label}</span>
                            <span className="mono muted">{device.serial}</span>
                          </span>
                        </button>
                        {device.location ? (
                          <div className="muted small">{device.location}</div>
                        ) : null}
                      </td>
                      <td className="nowrap">{DEVICE_MODELS[device.model].name}</td>
                      <td>
                        <StatusBadge status={device.status} />
                      </td>
                      <td className="mono nowrap">
                        v{device.configVersion}
                        {behind ? (
                          <Badge tone="warn">
                            device on v{device.appliedVersion}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="mono">{assigned.length}</td>
                      <td className="muted small nowrap">{timeAgo(device.lastSeenAt)}</td>
                      <td>
                        <div className="row-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="chevron"
                            onClick={() => setSelected(device)}
                          >
                            Open
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="trash"
                            onClick={() => setDeleting(device)}
                            aria-label={`Remove ${device.label}`}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating ? (
        <CreateDeviceModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            refresh();
          }}
        />
      ) : null}

      {selected ? (
        <DeviceDetail
          device={selected}
          lines={linesFor(selected.id)}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onDelete={() => setDeleting(selected)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Remove ${deleting.label}?`}
          message="The device will be deleted, its token revoked and its lines unassigned. This cannot be undone."
          confirmLabel="Remove device"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={remove}
        />
      ) : null}
    </>
  );
}

function CreateDeviceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [model, setModel] = useState<ModelKey>('t750');
  const [label, setLabel] = useState('');
  const [location, setLocation] = useState('');
  const [serial, setSerial] = useState('');
  const [mac, setMac] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ serial: string; code: string; expiresAt: string } | null>(null);
  const { push } = useToast();

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.createDevice({
        model,
        label: label.trim(),
        location: location.trim(),
        serial: serial.trim() || undefined,
        mac: mac.trim() || undefined,
      });
      if (res.enrollment) {
        setResult({
          serial: res.device.serial,
          code: res.enrollment.code,
          expiresAt: res.enrollment.expiresAt,
        });
      } else {
        push('Device added', 'ok');
        onClose();
      }
      onCreated();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not add the device', 'err');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal
        title="Enrollment code"
        subtitle={`For ${result.serial}`}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={() => {
                onClose();
              }}
            >
              Close
            </Button>
          </>
        }
      >
        <div className="callout ok">
          <strong>Enter this code on the device</strong>
          <span>
            It is valid for one enrollment and expires {timeAgo(result.expiresAt).includes('ago') ? 'shortly' : `in ${timeAgo(result.expiresAt).replace(' ago', '')}`}.
          </span>
        </div>
        <div
          className="card"
          style={{ padding: 18, textAlign: 'center', background: 'var(--bg-elevated)' }}
        >
          <div className="mono" style={{ fontSize: 30, letterSpacing: '0.14em' }}>
            {result.code}
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          The device exchanges this code once for its own token, then polls a signed configuration
          document. The code is stored hashed and is not shown again.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add a device"
      subtitle="Choose the hardware, then hand the owner an enrollment code"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!label.trim()} onClick={submit}>
            Add and issue code
          </Button>
        </>
      }
    >
      <div className="grid cols-2">
        {MODEL_KEYS.map((key) => {
          const info = DEVICE_MODELS[key];
          const active = model === key;
          return (
            <button
              key={key}
              onClick={() => setModel(key)}
              className="card"
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                padding: 14,
                borderColor: active ? 'var(--accent-line)' : 'var(--line)',
                background: active ? 'var(--accent-soft)' : 'var(--panel)',
                display: 'grid',
                gap: 6,
              }}
            >
              <div className="row">
                <strong>{info.name}</strong>
                {active ? <Icon name="check" size={14} /> : null}
              </div>
              <span className="muted small">{info.summary}</span>
              <div className="row wrap small muted" style={{ gap: 10 }}>
                <span>{info.accountSlots} accounts</span>
                <span>{info.voicePorts} voice port(s)</span>
                <span>{info.network.poe ? 'PoE' : 'external PSU'}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="form-grid">
        <Field label="Label" span>
          <input
            className="input"
            value={label}
            autoFocus
            placeholder="Reception desk"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Location">
          <input
            className="input"
            value={location}
            placeholder="HQ — Ground floor"
            onChange={(e) => setLocation(e.target.value)}
          />
        </Field>
        <Field label="Serial" help="Leave blank to generate one">
          <input
            className="input mono"
            value={serial}
            placeholder={`${model.toUpperCase()}-2026-000000`}
            onChange={(e) => setSerial(e.target.value)}
          />
        </Field>
        <Field label="MAC address" help="Optional, used for inventory matching">
          <input
            className="input mono"
            value={mac}
            placeholder="AA:42:10:7C:11:01"
            onChange={(e) => setMac(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function DeviceDetail({
  device,
  lines,
  onClose,
  onChanged,
  onDelete,
}: {
  device: Device;
  lines: Line[];
  onClose: () => void;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const config = useAsync<{ config: DeviceConfig; etag: string }>(() => api.deviceConfig(device.id), [
    device.id,
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const { push } = useToast();
  const info = DEVICE_MODELS[device.model];

  const act = async (name: string, run: () => Promise<void>) => {
    setBusy(name);
    try {
      await run();
      onChanged();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Action failed', 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title={device.label}
      subtitle={`${info.name} · ${device.serial}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="danger" icon="trash" onClick={onDelete}>
            Remove
          </Button>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="row wrap">
        <StatusBadge status={device.status} />
        <Badge>config v{device.configVersion}</Badge>
        {device.appliedVersion !== null ? (
          <Badge tone={device.appliedVersion < device.configVersion ? 'warn' : undefined}>
            device on v{device.appliedVersion}
          </Badge>
        ) : null}
        {device.firmware ? <Badge>firmware {device.firmware}</Badge> : null}
      </div>

      <div className="grid cols-2">
        <div className="stack small">
          <div className="row">
            <span className="muted">Serial</span>
            <span className="spacer mono">{device.serial}</span>
          </div>
          <div className="row">
            <span className="muted">MAC</span>
            <span className="spacer mono">{device.mac ?? '—'}</span>
          </div>
          <div className="row">
            <span className="muted">Location</span>
            <span className="spacer">{device.location || '—'}</span>
          </div>
          {/* Re-classifiable on purpose: an imported record can predate its
              hardware being in the catalog, and the model decides which voice
              document the device is served. */}
          <div className="row">
            <span className="muted">Model</span>
            <span className="spacer">
              <select
                className="select"
                value={device.model}
                aria-label="Device model"
                disabled={busy === 'model'}
                onChange={(event) =>
                  act('model', async () => {
                    await api.updateDevice(device.id, { model: event.target.value as ModelKey });
                    push('Model updated — a new configuration revision is waiting', 'ok');
                    config.reload();
                  })
                }
              >
                {MODEL_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {DEVICE_MODELS[key].name}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>
        <div className="stack small">
          <div className="row">
            <span className="muted">Enrolled</span>
            <span className="spacer">{formatDate(device.lastEnrolledAt)}</span>
          </div>
          <div className="row">
            <span className="muted">Last seen</span>
            <span className="spacer">{timeAgo(device.lastSeenAt)}</span>
          </div>
          <div className="row">
            <span className="muted">Token rotated</span>
            <span className="spacer">{timeAgo(device.tokenRotatedAt)}</span>
          </div>
          {device.model === 'ht802' ? (
            <div className="row">
              <span className="muted">Adaptor address</span>
              <span className="spacer mono">{device.addr ?? 'not enrolled'}</span>
            </div>
          ) : null}
        </div>
      </div>

      <hr className="sep" />

      <div className="row wrap">
        <Button
          size="sm"
          icon="refresh"
          loading={busy === 'reconfigure'}
          onClick={() =>
            act('reconfigure', async () => {
              await api.reconfigure(device.id);
              push('New configuration revision issued', 'ok');
              config.reload();
            })
          }
        >
          Issue new revision
        </Button>
        <Button
          size="sm"
          icon="key"
          loading={busy === 'rotate'}
          onClick={() =>
            act('rotate', async () => {
              const res = await api.rotateToken(device.id);
              setToken(res.token);
              push('Device token rotated — the old one is dead', 'ok');
            })
          }
        >
          Rotate token
        </Button>
        <Button
          size="sm"
          icon="shield"
          loading={busy === 'verify'}
          onClick={() =>
            act('verify', async () => {
              const res = await api.verifyConfig(device.id);
              push(
                res.signatureMatches
                  ? `Signature verifies with ${res.keyId}`
                  : 'Signature does not match — key or body changed',
                res.signatureMatches ? 'ok' : 'err',
              );
            })
          }
        >
          Verify signature
        </Button>
        <Button size="sm" variant="ghost" icon="terminal" onClick={() => setShowConfig((v) => !v)}>
          {showConfig ? 'Hide' : 'Show'} config
        </Button>
      </div>

      {token ? (
        <div className="callout ok">
          <strong>New device token — copy it now</strong>
          <Copyable value={token} />
          <span className="small muted">It is stored only as a digest and cannot be shown again.</span>
        </div>
      ) : null}

      {lines.length > 0 ? (
        <div className="stack">
          <strong style={{ fontSize: 13 }}>Lines on this device</strong>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ext</th>
                  <th>Address</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="mono">{line.extension}</td>
                    <td className="mono small">{line.aor}</td>
                    <td className="small">{line.routingMode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="callout warn">
          <strong>No lines assigned</strong>
          <span>Assign an extension on the Lines page so this device has something to ring.</span>
        </div>
      )}

      {device.model === 'ht802' ? <AdaptorPanel device={device} lines={lines} /> : null}

      {showConfig ? (
        config.loading ? (
          <SkeletonRows rows={6} />
        ) : config.error ? (
          <ErrorBox message={config.error} onRetry={config.reload} />
        ) : (
          <div className="stack">
            <div className="row small muted">
              <span>ETag</span>
              <code className="mono">{config.data?.etag}</code>
            </div>
            <pre className="code">{JSON.stringify(config.data?.config, null, 2)}</pre>
          </div>
        )
      ) : null}
    </Modal>
  );
}

const ADAPTOR_STATE: Record<AdaptorOverview['state'], { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  online: { label: 'Signed in', tone: 'ok' },
  reachable: { label: 'Reachable, not signed in', tone: 'warn' },
  locked: { label: 'Locked out', tone: 'err' },
  auth: { label: 'Password refused', tone: 'err' },
  stale: { label: 'Session went stale', tone: 'warn' },
  unreachable: { label: 'Unreachable', tone: 'err' },
};

/**
 * The analog adaptor's own report.
 *
 * Deliberately not a proxy to the box's web page: that console is served by a
 * web server that writes malformed HTTP, knows nothing about a Telno extension,
 * and describes a port as a table cell. This renders what the platform read
 * instead, and is honest about which parts the firmware would not surrender.
 */
function AdaptorPanel({ device, lines }: { device: Device; lines: Line[] }) {
  const [nonce, setNonce] = useState(0);
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  /** Account slot whose editor is open, or null. One at a time keeps the write obvious. */
  const [editing, setEditing] = useState<number | null>(null);
  const { push } = useToast();
  const adaptor = useAsync<{ adaptor: AdaptorOverview; passwordConfigured: boolean }>(
    () => api.deviceAta(device.id, nonce > 0),
    [device.id, nonce],
  );

  const view = adaptor.data?.adaptor ?? null;
  const passwordConfigured = adaptor.data?.passwordConfigured ?? true;
  const state = view ? ADAPTOR_STATE[view.state] : null;

  const reboot = async () => {
    setRebooting(true);
    try {
      await api.rebootAta(device.id);
      push('Adaptor is restarting — it drops off the network for about a minute.', 'ok');
      setConfirmReboot(false);
      setNonce((n) => n + 1);
    } catch (error) {
      push(error instanceof Error ? error.message : 'The adaptor did not accept the reboot', 'err');
    } finally {
      setRebooting(false);
    }
  };

  return (
    <>
      <hr className="sep" />
      <div className="row wrap">
        <strong style={{ fontSize: 13 }}>Adaptor</strong>
        {state ? <Badge tone={state.tone} dot>{state.label}</Badge> : null}
        {view ? <Badge>firmware {view.firmware}</Badge> : null}
        {view ? <Badge>{view.target.label}</Badge> : null}
        {view?.cached ? <Badge>cached</Badge> : null}
        <div className="spacer" />
        <Button size="sm" icon="refresh" loading={adaptor.loading} onClick={() => setNonce((n) => n + 1)}>
          Probe
        </Button>
        <Button
          size="sm"
          variant={confirmReboot ? 'danger' : 'ghost'}
          icon="bolt"
          loading={rebooting}
          disabled={!view?.reachable}
          onClick={() => (confirmReboot ? reboot() : setConfirmReboot(true))}
          onBlur={() => setConfirmReboot(false)}
        >
          {confirmReboot ? 'Confirm reboot' : 'Reboot'}
        </Button>
      </div>

      {adaptor.loading && !view ? (
        <SkeletonRows rows={3} />
      ) : adaptor.error ? (
        <ErrorBox message={adaptor.error} onRetry={() => setNonce((n) => n + 1)} />
      ) : view ? (
        <div className="stack">
          {!passwordConfigured ? (
            <div className="callout warn">
              <strong>No adaptor password is configured</strong>
              <span>
                The platform can reach the box but cannot sign in to it. Set <code>TELNO_ATA_PASSWORD</code> and
                restart to read its ports and SIP accounts; no login attempt is being spent meanwhile.
              </span>
            </div>
          ) : null}

          {view.locked ? (
            <div className="callout warn">
              <strong>Locked out for another {Math.ceil(view.remainSec)}s</strong>
              <span>
                {view.lock?.invalidAttempts ?? 0} logins were refused, and this firmware counts every attempt.
                The platform will not try a password until the timer runs out.
              </span>
            </div>
          ) : null}

          {view.notes
            // The callout above already explains a missing password; the driver
            // says the same thing in its own words.
            .filter((note) => passwordConfigured || !/no admin password is configured/i.test(note))
            .map((note) => (
              <div className="callout warn" key={note}>
                <span>{note}</span>
              </div>
            ))}

          <div className="grid cols-2">
            <div className="stack small">
              <div className="row">
                <span className="muted">Model</span>
                <span className="spacer">{view.identity?.model ?? '—'}</span>
              </div>
              <div className="row">
                <span className="muted">Serial</span>
                <span className="spacer mono">{view.identity?.serial ?? '—'}</span>
              </div>
              <div className="row">
                <span className="muted">MAC</span>
                <span className="spacer mono">{view.identity?.mac ?? '—'}</span>
              </div>
            </div>
            <div className="stack small">
              <div className="row">
                <span className="muted">Uptime</span>
                <span className="spacer">{view.identity?.uptime ?? '—'}</span>
              </div>
              <div className="row">
                <span className="muted">IP</span>
                <span className="spacer mono">{view.identity?.ip ?? view.target.host}</span>
              </div>
              <div className="row">
                <span className="muted">Voice image</span>
                <span className="spacer mono">{view.system?.voiceImage ?? '—'}</span>
              </div>
              <div className="row">
                <span className="muted">SIP profile</span>
                <span className="spacer">{view.sip ? (view.sip.exists ? 'present' : 'none') : '—'}</span>
              </div>
              <div className="row">
                <span className="muted">Checked</span>
                <span className="spacer">
                  {timeAgo(view.checkedAt)} · {view.tookMs} ms
                </span>
              </div>
            </div>
          </div>

          {view.ports.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>FXS</th>
                    <th>Hook</th>
                    <th>Registration</th>
                    <th>SIP user</th>
                  </tr>
                </thead>
                <tbody>
                  {view.ports.map((port) => (
                    <tr key={port.port}>
                      <td className="mono">{port.port}</td>
                      <td className="small">{port.hook ?? '—'}</td>
                      <td className="small">{port.registration ?? '—'}</td>
                      <td className="mono small">{port.sipUser ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="row small muted">
              <span>This firmware reported no FXS port state.</span>
            </div>
          )}

          {view.accounts.length > 0 ? (
            <div className="stack">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Telno line</th>
                      <th>SIP server</th>
                      <th>User</th>
                      <th>Local port</th>
                      <th>Registration</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {view.accounts.map((account) => {
                      const assigned = platformLineFor(lines, account.port);
                      return (
                        <tr key={account.port}>
                          <td className="mono">{account.port}</td>
                          <td className="small">
                            {assigned ? (
                              <>
                                <span className="mono">{assigned.extension}</span>{' '}
                                <span className="muted">{assigned.displayName}</span>
                              </>
                            ) : (
                              <span className="muted">unassigned</span>
                            )}
                          </td>
                          <td className="mono small">{account.server ?? '—'}</td>
                          <td className="mono small">{account.user ?? '—'}</td>
                          <td className="mono small">{account.localPort ?? '—'}</td>
                          <td className="small">
                            <Registration account={account} />
                          </td>
                          <td>
                            {view.firmware === 'v2' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon="edit"
                                disabled={!passwordConfigured || !view.reachable}
                                onClick={() => setEditing(editing === account.port ? null : account.port)}
                              >
                                {account.user ? 'Change' : 'Set'} extension
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {view.firmware === 'v2' ? null : (
                <div className="callout">
                  <span className="small">
                    This firmware takes its SIP account as a configuration form, not as an API write, so
                    extensions are set on the box's own page and only read here.
                  </span>
                </div>
              )}

              {editing !== null && view.firmware === 'v2' ? (
                <LineEditor
                  key={editing}
                  deviceId={device.id}
                  account={view.accounts.find((a) => a.port === editing) ?? view.accounts[0]!}
                  platformLine={platformLineFor(lines, editing)}
                  onDone={(changed) => {
                    setEditing(null);
                    // The read-back is the point of the write: re-probe rather than
                    // redraw the row from what we just asked for.
                    if (changed) setNonce((n) => n + 1);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The platform's own line for an adaptor slot, if an installer assigned one. */
function platformLineFor(lines: Line[], slot: number): Line | null {
  return lines.find((line) => line.accountSlot === slot) ?? null;
}

/**
 * What the firmware says about one line's registration.
 *
 * Three states, not two: a unit that cannot report (older firmware) is not a
 * unit whose line is down, and rendering it as "not registered" would send an
 * operator chasing hardware that is fine.
 */
function Registration({ account }: { account: AdaptorAccount }) {
  if (account.registered === true) {
    return (
      <Badge tone="ok" dot>
        {account.registration ?? 'registered'}
      </Badge>
    );
  }
  if (account.registered === false) {
    return (
      <Badge tone="warn" dot>
        {account.registration ?? 'not registered'}
      </Badge>
    );
  }
  return <span className="muted">not reported</span>;
}

/**
 * Write one line's SIP identity to the box.
 *
 * The write is verified on the device side and only reports `applied` when the
 * values read back, so this shows what the box holds afterwards rather than
 * echoing the form back as success.
 */
function LineEditor({
  deviceId,
  account,
  platformLine,
  onDone,
}: {
  deviceId: string;
  account: AdaptorAccount;
  platformLine: Line | null;
  onDone: (changed: boolean) => void;
}) {
  const { push } = useToast();
  const [extension, setExtension] = useState(platformLine?.extension ?? account.user ?? '');
  const [authId, setAuthId] = useState('');
  const [name, setName] = useState(platformLine?.displayName ?? account.name ?? '');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ext = extension.trim();
    // The same rule the server applies, so the operator is told before a write is
    // attempted rather than after the box has accepted a number it cannot ring.
    const problem = extensionProblem(ext);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.setAtaAccount(deviceId, {
        account: account.port,
        extension: ext,
        authId: authId.trim() || undefined,
        name: name.trim() || undefined,
        secret: secret || undefined,
      });
      push(
        result.applied
          ? `Line ${result.account} now holds ${result.user} and reads back ${result.registration}.`
          : `The box acknowledged the write but still reads back ${result.user ?? 'an empty user'} — ${result.note}`,
        result.applied ? 'ok' : 'err',
      );
      // Registered is not the same as ringing: the unit will hold an identity the
      // estate has no line for, and say nothing about it.
      if (result.warning) push(result.warning, 'warn');
      onDone(result.applied);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The adaptor did not accept the write');
    } finally {
      setSaving(false);
    }
  };

  const drift =
    platformLine && account.user && platformLine.extension !== account.user
      ? `The platform has ${platformLine.extension} on this slot and the box holds ${account.user}.`
      : null;

  return (
    <form className="callout" onSubmit={submit}>
      <strong>
        Line {account.port} — {account.user ? 'change the extension' : 'put an extension on this line'}
      </strong>
      {drift ? <span className="small">{drift}</span> : null}
      <div className="grid cols-2">
        <Field label="Extension" help="The SIP user id the line registers as.">
          <input
            className="mono"
            value={extension}
            onChange={(event) => setExtension(event.target.value)}
            placeholder="201"
            inputMode="numeric"
            pattern="[0-9]{2,6}"
            autoFocus
            required
          />
        </Field>
        <Field label="Auth id" help="Defaults to the extension; only differs when the box authenticates as another name.">
          <input
            className="mono"
            value={authId}
            onChange={(event) => setAuthId(event.target.value)}
            placeholder={extension.trim() || 'same as extension'}
          />
        </Field>
        <Field label="Display name" help="Shown on the box's own console and used as caller ID.">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Reception" />
        </Field>
        <Field
          label="SIP password"
          help="Written to the box; never returned, echoed or logged. Leave blank to keep the current one."
        >
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="new-password"
            placeholder="unchanged"
          />
        </Field>
      </div>
      {error ? <ErrorBox message={error} /> : null}
      <div className="row">
        <Button size="sm" icon="check" loading={saving} type="submit">
          Write to line {account.port}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
