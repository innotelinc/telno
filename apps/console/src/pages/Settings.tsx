import { useEffect, useState } from 'react';
import type { SessionUser, Settings } from '@telno/shared';
import { api } from '../api';
import { Button, ErrorBox, Field, SkeletonRows, useAsync, useToast } from '../ui';

export function SettingsPage({ user }: { user: SessionUser }) {
  const settings = useAsync(() => api.settings(), []);
  const { push } = useToast();

  const [form, setForm] = useState<Partial<Settings>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data?.settings) setForm(settings.data.settings);
  }, [settings.data]);

  const set = (key: keyof Settings, value: string | number | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.updateSettings(form);
      setForm(res.settings);
      push('Settings saved', 'ok');
      settings.reload();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not save settings', 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="grid split">
        <div className="card">
          <div className="card-head">
            <h2>Organisation</h2>
            <span className="hint">Names the platform uses in addresses and documents</span>
          </div>
          {settings.loading && !settings.data ? (
            <SkeletonRows rows={6} />
          ) : settings.error ? (
            <div className="card-body">
              <ErrorBox message={settings.error} onRetry={settings.reload} />
            </div>
          ) : (
            <div className="card-body stack">
              <div className="form-grid">
                <Field label="Platform name">
                  <input
                    className="input"
                    value={form.orgName ?? ''}
                    onChange={(e) => set('orgName', e.target.value)}
                  />
                </Field>
                <Field label="Directory domain" help="Used to build addresses of record">
                  <input
                    className="input mono"
                    value={form.domain ?? ''}
                    onChange={(e) => set('domain', e.target.value)}
                  />
                </Field>
                <Field label="Timezone">
                  <input
                    className="input"
                    value={form.timezone ?? ''}
                    onChange={(e) => set('timezone', e.target.value)}
                  />
                </Field>
                <Field label="NTP server" help="Handed to devices in their config">
                  <input
                    className="input mono"
                    value={form.ntp ?? ''}
                    onChange={(e) => set('ntp', e.target.value)}
                  />
                </Field>
              </div>

              <hr className="sep" />

              <div className="form-grid">
                <Field label="Voice node" help="Host a device announces to cantus">
                  <input
                    className="input mono"
                    value={form.voiceNode ?? ''}
                    placeholder="voice.telno.local"
                    onChange={(e) => set('voiceNode', e.target.value)}
                  />
                </Field>
                <Field label="Voice port" help="One UDP port for signalling and media">
                  <input
                    className="input mono"
                    type="number"
                    value={form.voicePort ?? 7443}
                    onChange={(e) => set('voicePort', Number(e.target.value))}
                  />
                </Field>
                <Field label="Relay" help="Optional relay host:port for hard NAT">
                  <input
                    className="input mono"
                    value={form.relay ?? ''}
                    onChange={(e) => set('relay', e.target.value)}
                  />
                </Field>
                <Field label="Session lifetime" help="Hours before an operator is signed out">
                  <input
                    className="input mono"
                    type="number"
                    value={form.sessionHours ?? 12}
                    onChange={(e) => set('sessionHours', Number(e.target.value))}
                  />
                </Field>
              </div>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.requireSignedConfig ?? true}
                  onChange={(e) => set('requireSignedConfig', e.target.checked)}
                />
                Require signed configuration documents
              </label>

              <div>
                <Button variant="primary" loading={saving} onClick={save}>
                  Save settings
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Console access</h2>
              <span className="hint">CIDR allowlist</span>
            </div>
            <div className="card-body stack">
              <Field
                label="Allowed networks"
                help="Comma-separated CIDRs. Sign-in and console API calls from outside this list are refused; device provisioning is not affected."
              >
                <textarea
                  className="textarea mono"
                  rows={3}
                  spellCheck={false}
                  value={form.trustedNetworks ?? ''}
                  onChange={(e) => set('trustedNetworks', e.target.value)}
                />
              </Field>
              {(form.trustedNetworks ?? '').split(',').some((entry) => /\/0$/.test(entry.trim())) ? (
                <div className="callout err">
                  <strong>This allows every address</strong>
                  <span>A /0 entry disables the allowlist entirely.</span>
                </div>
              ) : (
                <div className="callout ok">
                  <strong>Allowlist active</strong>
                  <span>
                    {settings.data?.settings.trustedNetworks === form.trustedNetworks
                      ? 'Saved. Changes apply to the next request, with no restart.'
                      : 'Unsaved changes — save to apply them immediately.'}
                  </span>
                </div>
              )}
              <div>
                <Button loading={saving} onClick={save}>
                  Save allowlist
                </Button>
              </div>
            </div>
          </div>

          <PasswordCard />

          <div className="card">
            <div className="card-head">
              <h2>Signing key</h2>
            </div>
            <div className="card-body stack">
              <div className="row small">
                <span className="muted">Key id</span>
                <span className="spacer mono">{settings.data?.settings.keyId ?? '—'}</span>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Every configuration document names this key and carries an HMAC over its canonical
                body. A device refuses a document whose key id it does not know.
              </p>
              <div className="callout warn">
                <strong>Rotation</strong>
                <span>
                  Rotating the key is an out-of-band operation: set{' '}
                  <span className="mono">TELNO_PROVISIONING_KEY</span> and restart, then issue a new
                  revision so every device re-fetches.
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Operator</h2>
            </div>
            <div className="card-body stack small">
              <div className="row">
                <span className="muted">Signed in as</span>
                <span className="spacer mono">{user.username}</span>
              </div>
              <div className="row">
                <span className="muted">Role</span>
                <span className="spacer">{user.role}</span>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Sessions are stored server-side and revoked on password change.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 10;

  const submit = async () => {
    setBusy(true);
    try {
      await api.changePassword(current, next);
      push('Password changed — sign in again', 'ok');
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not change the password', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Password</h2>
        <span className="hint">All sessions end when it changes</span>
      </div>
      <div className="card-body stack">
        <Field label="Current password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password" help="At least 10 characters">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Repeat new password">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {mismatch ? <span className="small" style={{ color: 'var(--err)' }}>Passwords do not match.</span> : null}
        {tooShort ? <span className="small" style={{ color: 'var(--warn)' }}>Use at least 10 characters.</span> : null}
        <div>
          <Button
            loading={busy}
            disabled={!current || next.length < 10 || next !== confirm}
            onClick={submit}
          >
            Change password
          </Button>
        </div>
      </div>
    </div>
  );
}
