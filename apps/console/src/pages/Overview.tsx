import type { Overview } from '@telno/shared';
import { DEVICE_MODELS } from '@telno/shared';
import { api } from '../api';
import type { PageKey } from '../App';
import { Badge, Button, ErrorBox, Icon, SkeletonRows, formatTime, useAsync } from '../ui';

export function OverviewPage({ onNavigate }: { onNavigate: (page: PageKey) => void }) {
  const { data, error, loading, reload } = useAsync<Overview>(() => api.overview(), []);

  if (loading && !data) {
    return (
      <div className="grid cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div className="card" key={i}>
            <SkeletonRows rows={2} />
          </div>
        ))}
      </div>
    );
  }

  if (error || !data) {
    return <ErrorBox message={error ?? 'No data returned'} onRetry={reload} />;
  }

  const voiceOk = data.cantus.available && data.cantus.selftest?.ok;

  return (
    <>
      <div className="grid cols-4">
        <div className="card">
          <div className="kpi">
            <span className="label">Devices</span>
            <span className="value">{data.devices.total}</span>
            <span className="meta">
              {data.devices.online} online · {data.devices.pending} pending
            </span>
          </div>
        </div>
        <div className="card">
          <div className="kpi">
            <span className="label">Lines</span>
            <span className="value">{data.lines.enabled}</span>
            <span className="meta">{data.lines.total} configured</span>
          </div>
        </div>
        <div className="card">
          <div className="kpi">
            <span className="label">Directory</span>
            <span className="value">{data.directory.total}</span>
            <span className="meta">shared phonebook entries</span>
          </div>
        </div>
        <div className="card">
          <div className="kpi">
            <span className="label">Voice</span>
            <span className="value" style={{ fontSize: 22 }}>
              {voiceOk ? 'cantus ready' : data.cantus.available ? 'degraded' : 'offline'}
            </span>
            <span className="meta">
              {voiceOk ? 'one socket, traversal always on' : data.cantus.reason ?? 'check diagnostics'}
            </span>
          </div>
        </div>
      </div>

      <div className="grid split">
        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <h2>Fleet</h2>
              <span className="hint">Firmware and configuration revision per model</span>
              <div className="spacer" />
              <Button size="sm" variant="ghost" icon="phone" onClick={() => onNavigate('devices')}>
                Manage
              </Button>
            </div>
            <div className="card-body">
              <div className="stack">
                {data.modelMix.length === 0 ? (
                  <span className="muted small">No devices enrolled yet.</span>
                ) : (
                  data.modelMix.map((mix) => {
                    const total = Math.max(data.devices.total, 1);
                    const pct = Math.round((mix.count / total) * 100);
                    return (
                      <div key={mix.model} className="stack" style={{ gap: 6 }}>
                        <div className="row">
                          <strong style={{ fontSize: 13 }}>{DEVICE_MODELS[mix.model].name}</strong>
                          <span className="badge">{DEVICE_MODELS[mix.model].formFactor}</span>
                          <span className="spacer mono muted">{mix.count}</span>
                        </div>
                        <div className="progress">
                          <span style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Recent activity</h2>
              <span className="hint">Control-plane event ledger</span>
              <div className="spacer" />
              <Button size="sm" variant="ghost" icon="refresh" onClick={reload}>
                Refresh
              </Button>
            </div>
            <div className="card-body tight">
              {data.events.length === 0 ? (
                <div className="empty small">No activity recorded yet.</div>
              ) : (
                <div className="event-list">
                  {data.events.map((event) => (
                    <div key={event.id} className={`event ${event.level}`}>
                      <span className="time">{formatTime(event.createdAt)}</span>
                      <span className="kind">{event.kind}</span>
                      <span className="msg">{event.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid" style={{ gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <h2>Voice stack</h2>
              <div className="spacer" />
              <Badge tone={voiceOk ? 'ok' : 'err'} dot>
                {voiceOk ? 'healthy' : 'attention'}
              </Badge>
            </div>
            <div className="card-body stack">
              <div className="row">
                <Icon name="terminal" size={14} />
                <span className="dim small">{data.cantus.version ?? 'cantus CLI not found'}</span>
              </div>
              <div className="row">
                <Icon name="shield" size={14} />
                <span className="dim small">
                  signing key <code className="mono">{data.provisioning.keyId}</code>
                </span>
              </div>
              <div className="row">
                <Icon name="layers" size={14} />
                <span className="dim small">{data.provisioning.revisions} routing revisions</span>
              </div>
              <hr className="sep" />
              <p className="muted small" style={{ margin: 0 }}>
                Devices negotiate with cantus over one UDP socket. There is no SIP registrar, no
                SDP and no RTP range to keep open.
              </p>
              <Button size="sm" icon="pulse" onClick={() => onNavigate('diagnostics')}>
                Open diagnostics
              </Button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Needs attention</h2>
            </div>
            <div className="card-body stack">
              {data.devices.pending > 0 ? (
                <div className="callout warn">
                  <strong>{data.devices.pending} device(s) awaiting enrollment</strong>
                  <span>Issue or re-use an enrollment code to bring them online.</span>
                  <div>
                    <Button size="sm" onClick={() => onNavigate('provisioning')}>
                      Provision
                    </Button>
                  </div>
                </div>
              ) : null}
              {data.devices.offline > 0 ? (
                <div className="callout warn">
                  <strong>{data.devices.offline} device(s) offline</strong>
                  <span>They will retry their configuration poll automatically.</span>
                </div>
              ) : null}
              {!voiceOk ? (
                <div className="callout err">
                  <strong>cantus is not answering</strong>
                  <span>{data.cantus.reason ?? 'Run the self-test in Diagnostics.'}</span>
                </div>
              ) : null}
              {data.devices.pending === 0 && data.devices.offline === 0 && voiceOk ? (
                <div className="callout ok">
                  <strong>Everything is healthy</strong>
                  <span>
                    All {data.devices.online} online devices polled within the last check window.
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
