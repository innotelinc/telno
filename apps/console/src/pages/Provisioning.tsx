import { useState } from 'react';
import type { ModelKey } from '@telno/shared';
import { DEVICE_MODELS, MODEL_KEYS } from '@telno/shared';
import { api } from '../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Icon,
  Modal,
  SkeletonRows,
  formatDate,
  timeAgo,
  useAsync,
  useToast,
} from '../ui';

export function ProvisioningPage() {
  const provisioning = useAsync(() => api.provisioning(), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const codes = provisioning.data?.codes ?? [];

  const removeCode = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteCode(deleting.id);
      push('Enrollment code revoked', 'ok');
      setDeleting(null);
      provisioning.reload();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not revoke the code', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid cols-2">
        {provisioning.loading && !provisioning.data
          ? MODEL_KEYS.map((key) => (
              <div className="card" key={key}>
                <SkeletonRows rows={4} />
              </div>
            ))
          : MODEL_KEYS.map((key) => {
              const model = DEVICE_MODELS[key];
              const profile = provisioning.data?.profiles.find((p) => p.model === key);
              return (
                <div className="card" key={key}>
                  <div className="card-head">
                    <h2>{model.name}</h2>
                    <div className="spacer" />
                    <Badge tone="accent">{profile?.deviceCount ?? 0} devices</Badge>
                  </div>
                  <div className="card-body stack">
                    <div className="row small">
                      <span className="muted">Schema</span>
                      <span className="spacer mono">{profile?.schema ?? 'telno.device.config/1'}</span>
                    </div>
                    <div className="row small">
                      <span className="muted">Signing key</span>
                      <span className="spacer mono">{profile?.keyId ?? '—'}</span>
                    </div>
                    <div className="row small">
                      <span className="muted">Routing revision</span>
                      <span className="spacer mono">v{profile?.revision ?? 0}</span>
                    </div>
                    <div className="row small">
                      <span className="muted">Accounts</span>
                      <span className="spacer">{model.accountSlots}</span>
                    </div>
                    <p className="muted small" style={{ margin: 0 }}>
                      {model.summary}
                    </p>
                  </div>
                </div>
              );
            })}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Enrollment codes</h2>
          <span className="hint">Single use, hashed at rest</span>
          <div className="spacer" />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            Issue code
          </Button>
        </div>
        {provisioning.loading && !provisioning.data ? (
          <SkeletonRows rows={3} />
        ) : provisioning.error ? (
          <div className="card-body">
            <ErrorBox message={provisioning.error} onRetry={provisioning.reload} />
          </div>
        ) : codes.length === 0 ? (
          <EmptyState
            title="No enrollment codes outstanding"
            message="Issue one when a device is ready to join; codes expire."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Model</th>
                  <th>Label</th>
                  <th>Issued</th>
                  <th>Expires</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => {
                  const expired = new Date(code.expiresAt).getTime() < Date.now();
                  return (
                    <tr key={code.id}>
                      <td className="mono">{code.code}</td>
                      <td className="small">{DEVICE_MODELS[code.model].name}</td>
                      <td className="small">{code.label}</td>
                      <td className="muted small">{formatDate(code.createdAt)}</td>
                      <td className="muted small">{expired ? 'expired' : timeAgo(code.expiresAt).replace(' ago', ' from now')}</td>
                      <td>
                        {code.usedAt ? (
                          <Badge tone="ok">used</Badge>
                        ) : expired ? (
                          <Badge tone="warn">expired</Badge>
                        ) : (
                          <Badge tone="accent">outstanding</Badge>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="trash"
                            onClick={() => setDeleting({ id: code.id, label: code.label })}
                            aria-label="Revoke code"
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

      <div className="card">
        <div className="card-head">
          <h2>Device protocol</h2>
          <span className="hint">What a T750 or HT802 does instead of fetching a vendor XML file</span>
        </div>
        <div className="card-body stack">
          <div className="grid cols-2">
            <div className="stack">
              <div className="row small">
                <Icon name="key" size={14} />
                <span className="mono">POST /prov/v1/enroll</span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                The device posts its enrollment code, serial, MAC and firmware once. It receives its
                own bearer token and the URL of the configuration document.
              </p>
              <div className="row small">
                <Icon name="download" size={14} />
                <span className="mono">GET /prov/v1/config</span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Authenticated with <span className="mono">Authorization: Bearer &lt;token&gt;</span>.
                The response carries <span className="mono">ETag</span> and{' '}
                <span className="mono">X-Telno-Config-Version</span>; an unchanged revision answers
                304, so polling costs nothing.
              </p>
              <div className="row small">
                <Icon name="shield" size={14} />
                <span className="mono">X-Telno-Signature</span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                The body is HMAC-SHA256 signed over a canonical form and names the key id it was
                signed with, so a rotated key or an edited field is detectable by the device.
              </p>
            </div>
            <div className="stack">
              <strong className="small">Signed document preview</strong>
              <pre className="code" style={{ maxHeight: 260 }}>
{`{
  "schema": "telno.device.config/1",
  "version": 3,
  "keyId": "${provisioning.data?.settings.keyId ?? 'tln-k-…'}",
  "device": { "serial": "T750-2026-000418", "model": "t750" },
  "voice": {
    "transport": "cantus/1",
    "node": "${provisioning.data?.settings.voiceNode || 'voice.telno.local'}",
    "port": ${provisioning.data?.settings.voicePort ?? 7443},
    "reachMs": 300
  },
  "routing": { "documentId": "${provisioning.data?.routing.documentId ?? 'rt-…'}", "revision": ${provisioning.data?.routing.revision ?? 0} },
  "signature": "…"
}`}
              </pre>
              <div className="callout">
                <strong>No vendor configuration dialect</strong>
                <span>
                  There is no per-MAC config filename, no parameter tree and no firmware URL baked
                  into the device profile. Everything a device needs is in this one document.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {creating ? (
        <CreateCodeModal
          keyId={provisioning.data?.settings.keyId ?? ''}
          onClose={() => setCreating(false)}
          onCreated={() => provisioning.reload()}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Revoke this code?"
          message={`Any device that has not already used the code for "${deleting.label}" will be refused.`}
          confirmLabel="Revoke"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={removeCode}
        />
      ) : null}
    </>
  );
}

function CreateCodeModal({
  keyId,
  onClose,
  onCreated,
}: {
  keyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [model, setModel] = useState<ModelKey>('t750');
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState('60');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const { push } = useToast();

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.createCode({
        model,
        label: label.trim() || 'Unassigned',
        ttlMinutes: Number(ttl) || 60,
      });
      setCode({ code: res.code, expiresAt: res.expiresAt });
      onCreated();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not issue a code', 'err');
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    return (
      <Modal
        title="Enrollment code issued"
        subtitle={`${DEVICE_MODELS[model].name} · expires ${new Date(code.expiresAt).toLocaleTimeString()}`}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="card" style={{ padding: 20, textAlign: 'center', background: 'var(--bg-elevated)' }}>
          <div className="mono" style={{ fontSize: 32, letterSpacing: '0.14em' }}>
            {code.code}
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          This is the only time the code is shown. It is stored as a digest and can be used once.
          Signing key <span className="mono">{keyId}</span>.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Issue an enrollment code"
      subtitle="One device, one code, one use"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Issue code
          </Button>
        </>
      }
    >
      <Field label="Model">
        <select className="select" value={model} onChange={(e) => setModel(e.target.value as ModelKey)}>
          {MODEL_KEYS.map((key) => (
            <option key={key} value={key}>
              {DEVICE_MODELS[key].name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Label" help="Shown in the inventory when the device enrolls">
        <input
          className="input"
          value={label}
          placeholder="Reception desk"
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field label="Valid for" help="5 minutes to 24 hours">
        <select className="select" value={ttl} onChange={(e) => setTtl(e.target.value)}>
          <option value="15">15 minutes</option>
          <option value="60">1 hour</option>
          <option value="240">4 hours</option>
          <option value="1440">24 hours</option>
        </select>
      </Field>
    </Modal>
  );
}
