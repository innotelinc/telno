import { useState } from 'react';
import type { CantusRouteDecision, PathProbeResult } from '@telno/shared';
import { api } from '../api';
import {
  Badge,
  Button,
  CodeBlock,
  ErrorBox,
  Field,
  Icon,
  SkeletonRows,
  formatTime,
  useAsync,
  useToast,
} from '../ui';

export function DiagnosticsPage() {
  const status = useAsync(() => api.cantusStatus(), []);
  const routing = useAsync(() => api.routingDocument(), []);
  const { push } = useToast();

  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    ok: boolean;
    verifiedBy: 'cantus' | 'local';
    output: string;
    errors: string[];
  } | null>(null);

  const [to, setTo] = useState('');
  const [hour, setHour] = useState('');
  const [decision, setDecision] = useState<(CantusRouteDecision & { raw: string }) | null>(null);
  const [testing, setTesting] = useState(false);

  const [nat, setNat] = useState<'none' | 'cone' | 'symmetric'>('symmetric');
  const [rebind, setRebind] = useState(false);
  const [probe, setProbe] = useState<PathProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const validate = async () => {
    setValidating(true);
    try {
      const result = await api.validateRouting(routing.data?.document);
      setValidation(result);
      push(
        result.ok ? `Document accepted by ${result.verifiedBy}` : 'Document rejected',
        result.ok ? 'ok' : 'err',
      );
    } catch (error) {
      push(error instanceof Error ? error.message : 'Validation failed', 'err');
    } finally {
      setValidating(false);
    }
  };

  const runRouteTest = async () => {
    if (!to.trim()) return;
    setTesting(true);
    try {
      const result = await api.routeTest({ to: to.trim(), hour: hour.trim() || undefined });
      setDecision(result);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Route test failed', 'err');
    } finally {
      setTesting(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    try {
      const result = await api.probe({ nat, rebind });
      setProbe(result);
      push(
        result.ok ? `Path probe passed over ${result.path}` : 'Path probe failed',
        result.ok ? 'ok' : 'err',
      );
    } catch (error) {
      push(error instanceof Error ? error.message : 'Probe failed', 'err');
    } finally {
      setProbing(false);
    }
  };

  const cantus = status.data;

  return (
    <>
      <div className="grid split">
        <div className="card">
          <div className="card-head">
            <h2>cantus voice stack</h2>
            <div className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              loading={status.loading}
              onClick={() => {
                status.reload();
                setValidation(null);
              }}
            >
              Re-check
            </Button>
          </div>
          {status.loading && !cantus ? (
            <SkeletonRows rows={5} />
          ) : status.error ? (
            <div className="card-body">
              <ErrorBox message={status.error} onRetry={status.reload} />
            </div>
          ) : (
            <div className="card-body stack">
              <div className="row wrap">
                <Badge tone={cantus?.available ? 'ok' : 'err'} dot>
                  {cantus?.available ? 'CLI available' : 'CLI unavailable'}
                </Badge>
                {cantus?.version ? <Badge>{cantus.version.split('—')[0]?.trim()}</Badge> : null}
                {cantus?.selftest ? (
                  <Badge tone={cantus.selftest.ok ? 'ok' : 'err'}>
                    selftest {cantus.selftest.ok ? 'pass' : 'fail'}
                  </Badge>
                ) : null}
              </div>

              {cantus?.reason ? (
                <div className="callout err">
                  <strong>Why cantus is not usable</strong>
                  <span>{cantus.reason}</span>
                </div>
              ) : null}

              {cantus?.selftest?.checks.length ? (
                <div className="stack" style={{ gap: 4 }}>
                  {cantus.selftest.checks.map((check) => (
                    <div key={check.name} className="row small">
                      <span style={{ color: check.ok ? 'var(--ok)' : 'var(--err)' }}>
                        <Icon name={check.ok ? 'check' : 'close'} size={13} />
                      </span>
                      <span className="dim">{check.name}</span>
                      <span className="spacer mono muted">{check.ok ? 'ok' : 'FAIL'}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="row small muted">
                <Icon name="terminal" size={13} />
                <span className="mono">{cantus?.binary}</span>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Live path probe</h2>
            <span className="hint">A real call over real sockets</span>
          </div>
          <div className="card-body stack">
            <div className="form-grid">
              <Field label="NAT" help="How the probe's middlebox behaves">
                <select
                  className="select"
                  value={nat}
                  onChange={(e) => setNat(e.target.value as typeof nat)}
                >
                  <option value="none">None (direct)</option>
                  <option value="cone">Cone</option>
                  <option value="symmetric">Symmetric</option>
                </select>
              </Field>
              <Field label="Rebinding" help="Flush the NAT table mid-call">
                <label className="checkbox" style={{ paddingTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={rebind}
                    disabled={nat === 'none'}
                    onChange={(e) => setRebind(e.target.checked)}
                  />
                  Recover from a mapping loss
                </label>
              </Field>
            </div>
            <Button icon="pulse" loading={probing} onClick={runProbe}>
              Run probe
            </Button>

            {probe ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="row wrap">
                  <Badge tone={probe.ok ? 'ok' : 'err'}>{probe.ok ? 'passed' : 'failed'}</Badge>
                  <Badge tone="accent">{probe.path ?? 'no path'}</Badge>
                  {probe.codec ? <Badge>{probe.codec}</Badge> : null}
                  {probe.rebind?.requested ? (
                    <Badge tone={probe.rebind.recoveredAtMs !== null ? 'ok' : 'warn'}>
                      {probe.rebind.recoveredAtMs !== null
                        ? `direct restored at ${(probe.rebind.recoveredAtMs / 1000).toFixed(2)}s`
                        : 'never recovered'}
                    </Badge>
                  ) : null}
                </div>
                <div className="row small muted">
                  <span>{probe.frames} audio frames</span>
                  <span>·</span>
                  <span>peak amplitude {probe.peak}</span>
                  <span>·</span>
                  <span>nat {probe.nat}</span>
                  <span className="spacer">{formatTime(probe.ranAt)}</span>
                </div>
                <CodeBlock value={probe.output} />
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                The probe starts a relay and two endpoints, places one call, and reports which path
                carried the audio. Nothing is simulated: the frames are counted at the receiver.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Routing document</h2>
          <span className="hint">
            revision {routing.data?.revision ?? '—'} · {routing.data?.document.routes.length ?? 0} routes
          </span>
          <div className="spacer" />
          <Button variant="primary" size="sm" icon="shield" loading={validating} onClick={validate}>
            Validate with cantus
          </Button>
        </div>
        {routing.loading && !routing.data ? (
          <SkeletonRows rows={6} />
        ) : routing.error ? (
          <div className="card-body">
            <ErrorBox message={routing.error} onRetry={routing.reload} />
          </div>
        ) : (
          <div className="card-body stack">
            {validation ? (
              <div className={`callout ${validation.ok ? 'ok' : 'err'}`}>
                <strong>
                  {validation.ok
                    ? `Accepted — verified by ${validation.verifiedBy === 'cantus' ? 'the cantus reference stack' : 'the local schema check only'}`
                    : 'Rejected'}
                </strong>
                {validation.verifiedBy === 'local' && validation.ok ? (
                  <span>
                    The cantus CLI was not reachable, so only the schema was checked. Run the
                    self-test above to restore full validation.
                  </span>
                ) : null}
                {validation.errors.length ? <span>{validation.errors.join(' · ')}</span> : null}
                <span className="mono small">{validation.output.split('\n')[0]}</span>
              </div>
            ) : null}
            <CodeBlock value={JSON.stringify(routing.data?.document, null, 2)} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Route tester</h2>
          <span className="hint">Evaluate the document offline — nothing is dialled</span>
        </div>
        <div className="card-body stack">
          <div className="form-grid">
            <Field label="Destination address" help="The address of record being called">
              <input
                className="input mono"
                value={to}
                placeholder="reception@telno.local"
                onChange={(e) => setTo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runRouteTest()}
              />
            </Field>
            <Field label="At time" help="Optional, HH:MM — checks business-hour windows">
              <input
                className="input mono"
                value={hour}
                placeholder="10:30"
                onChange={(e) => setHour(e.target.value)}
              />
            </Field>
          </div>
          <div>
            <Button icon="search" loading={testing} disabled={!to.trim()} onClick={runRouteTest}>
              Evaluate route
            </Button>
          </div>

          {decision ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row wrap">
                <Badge tone={decision.matched ? 'ok' : 'warn'}>
                  {decision.route ?? 'default route'}
                </Badge>
                {decision.actions.map((action, index) => (
                  <span key={`${action}-${index}`} className="row small muted" style={{ gap: 6 }}>
                    {index > 0 ? <Icon name="chevron" size={12} /> : null}
                    <span className="mono">{action}</span>
                  </span>
                ))}
              </div>
              <CodeBlock value={decision.raw} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="callout">
        <strong>What replaced the PBX</strong>
        <span>
          There is no SIP registrar, no SDP negotiation and no RTP port range here. Devices talk
          cantus over one socket; the console only decides routing and publishes signed
          configuration.
        </span>
      </div>
    </>
  );
}
