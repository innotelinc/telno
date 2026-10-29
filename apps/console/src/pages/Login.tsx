import { useState, type FormEvent } from 'react';
import type { SessionUser } from '@telno/shared';
import { api, ApiError } from '../api';
import { Button, Field, Icon } from '../ui';

export function Login({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(username.trim(), password);
      onSignedIn(res.user);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The control plane did not answer. Check that it is running.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <div className="brand-mark">
            <Icon name="phone" size={17} />
          </div>
          <div className="brand-text">
            <strong>Telno</strong>
            <span>Platform 2026</span>
          </div>
        </div>

        <div>
          <h1>Sign in</h1>
          <p>Manage T750 and HT802 devices, lines and cantus voice control.</p>
        </div>

        {error ? (
          <div className="callout err">
            <strong>Sign-in failed</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <Field label="Operator">
          <input
            className="input"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
            required
          />
        </Field>

        <Field label="Password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={busy} disabled={!username || !password}>
          Sign in
        </Button>

        <p className="small">
          Sessions are server-side and expire automatically. Change the bootstrap
          password in Settings after the first sign-in.
        </p>
      </form>
    </div>
  );
}
