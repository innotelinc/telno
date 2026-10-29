import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Link } from '../router.jsx';
import { Badge, Button, Card, Empty, Loading, Modal, PageHeader, Stat, useToast } from '../ui.jsx';

/**
 * The Telno HT8022026.
 *
 * This replaces the adaptor's own console rather than wrapping it. The old page
 * is a 2010-era server-rendered grid served by a web server that writes two
 * status lines per response, and it has no idea that the box is registered to a
 * Telno extension. So the platform does the reading (see `lib/ata/ht802.js`)
 * and this screen shows what an installer actually needs: is it up, is it
 * locked, is each FXS port registered, and where does it fetch its config.
 *
 * Every state gets words rather than a blank field. "This firmware did not
 * report a serial" is a fact about the box; an empty cell reads like a bug.
 */

const STATES = {
  online: {
    tone: 'success',
    dot: 'live',
    label: 'Online',
    blurb: 'Signed in and answering. Both rows below are live readings, not a cached page.',
  },
  locked: {
    tone: 'warning',
    dot: 'warn',
    label: 'Locked out',
    blurb:
      'The adaptor counts refused logins and locks its console for fifteen minutes. The platform will not send another password until the timer runs out.',
  },
  auth: {
    tone: 'danger',
    dot: 'down',
    label: 'Password refused',
    blurb: 'The adaptor is reachable but would not accept the admin password this deployment holds.',
  },
  unreachable: {
    tone: 'danger',
    dot: 'down',
    label: 'No answer',
    blurb: 'Nothing came back from that address. Check the IP, the network the platform runs on, and that the unit has power.',
  },
  // Its own state, not "No answer": the box is up and accepting the password,
  // it just will not hand over its values. Saying "no answer" here would send an
  // installer to check cabling that is fine.
  stale: {
    tone: 'warning',
    dot: 'warn',
    label: 'Connected, not readable',
    blurb:
      'The adaptor accepted the password but returned no settings, twice. Its console is running; the configuration is not being served right now.',
  },
};

const field = (value, fallback = 'Not reported') => (value === null || value === undefined || value === '' ? fallback : String(value));

const mono = {
  margin: 0,
  padding: 12,
  borderRadius: 'var(--radius)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-strong)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
};

export default function Device() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [targets, setTargets] = useState(null);
  const [provisioning, setProvisioning] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const ticker = useRef(null);

  const load = async ({ refresh = false } = {}) => {
    try {
      setError('');
      const [live, list, config] = await Promise.all([
        api.get(`/ata/state${refresh ? '?refresh=1' : ''}`),
        api.get('/ata/targets'),
        api.get('/ata/provisioning'),
      ]);
      setState(live);
      setTargets(list);
      setProvisioning(config);
      setRemaining(live.remainSec || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A lockout is the one number on this page that changes on its own, so it is
  // counted down rather than left at whatever the last probe said.
  useEffect(() => {
    if (ticker.current) clearInterval(ticker.current);
    if (!remaining) return undefined;
    ticker.current = setInterval(() => setRemaining((value) => (value > 0 ? value - 1 : 0)), 1000);
    return () => clearInterval(ticker.current);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = STATES[state?.state] || STATES.unreachable;
  const identity = state?.identity || {};
  // "Not reported" and "could not be read" are different facts, and the empty
  // panels below have to tell them apart or the page blames the firmware for a
  // box that never answered.
  const live = state?.state === 'online';
  // Reboot is implemented for the V1 console only; the V2 keeps its restart
  // behind an operation that has not been verified, so the button is refused
  // rather than firing something unknown at hardware.
  const canReboot = state?.firmware !== 'v2';
  const whyNotLive =
    state?.state === 'locked'
      ? 'the adaptor is locked out'
      : state?.state === 'auth'
        ? 'the adaptor refused the password'
        : state?.state === 'stale'
          ? 'the adaptor is not serving its settings'
          : 'the adaptor is not answering';
  // The V2 firmware exposes configuration, not live registration, so counting
  // "registered" there would be inventing a fact. Count what is known instead.
  const configured = (state?.ports || []).filter((port) => port.sipUser).length;
  const registered = (state?.ports || []).filter((port) => /registered|ok|idle|off hook|on hook/i.test(port.registration || '')).length;
  const portScore = state?.firmware === 'v2' ? configured : registered;

  const reboot = async () => {
    setBusy('reboot');
    try {
      const result = await api.post('/ata/reboot', {});
      setConfirmReboot(false);
      toast.success('Reboot requested', result.accepted ? 'The adaptor takes about a minute to come back.' : 'The unit accepted the request without a confirmation.');
      setTimeout(() => load({ refresh: true }), 5000);
    } catch (err) {
      toast.error('Could not reboot the adaptor', err.message);
    } finally {
      setBusy('');
    }
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy', 'Select the text and copy it manually.');
    }
  };

  const sources = useMemo(() => Object.entries(state?.sources || {}), [state]);

  if (loading) {
    return (
      <>
        <PageHeader title="HT8022026" subtitle="Analog telephone adaptor" />
        <Card><Loading rows={5} /></Card>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="HT8022026" subtitle="Analog telephone adaptor" />
        <Card>
          <Empty icon="alert" title="The console could not read the adaptor" action={<Button variant="primary" icon="refresh" onClick={() => load({ refresh: true })}>Try again</Button>}>
            {error}
          </Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="HT8022026"
        subtitle={`Analog adaptor at ${state?.target?.label || targets?.configured?.host || 'the configured address'}${state?.firmware ? ` · firmware ${state.firmware}` : ''}`}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button icon="refresh" loading={busy === 'refresh'} onClick={() => { setBusy('refresh'); load({ refresh: true }).finally(() => setBusy('')); }}>
              Read again
            </Button>
            <Button
              variant="danger"
              icon="play"
              disabled={!canReboot}
              title={canReboot ? 'Restart the adaptor' : 'Reboot is not wired for this firmware yet'}
              onClick={() => setConfirmReboot(true)}
            >
              Reboot
            </Button>
          </div>
        }
      />

      <Card
        title={
          <div className="row" style={{ gap: 10 }}>
            <span>Connection</span>
            <Badge tone={meta.tone} dot={meta.dot}>{meta.label}</Badge>
            {state?.cached ? <Badge tone="neutral">cached</Badge> : null}
          </div>
        }
        subtitle={meta.blurb}
        actions={<span className="tiny dim">{state?.tookMs} ms · checked {state?.checkedAt ? new Date(state.checkedAt).toLocaleTimeString() : '—'}</span>}
      >
        <div className="stack">
          {state?.state === 'locked' ? (
            <div className="row wrap" style={{ gap: 10 }}>
              <Badge tone="warning" dot="warn">{remaining ? `${Math.floor(remaining / 60)}m ${remaining % 60}s left` : 'timer finished'}</Badge>
              <span className="tiny dim">
                {state.lock?.invalidAttempts || 0} refused attempts so far. Nothing to do but wait — sending another password restarts the timer.
              </span>
            </div>
          ) : null}

          {state?.state === 'auth' ? (
            <p className="tiny dim">
              Set <code className="mono">ATA_PASSWORD</code> for this deployment to the adaptor's admin password and read again. The password is never
              stored in the database and never leaves the server.
            </p>
          ) : null}

          {state?.notes?.length ? (
            <ul className="tiny dim" style={{ margin: 0, paddingLeft: 18 }}>
              {state.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      <div className="grid stats">
        <Stat label="Model" value={field(identity.model, 'HT802')} foot="Reported by the unit" />
        <Stat label="Firmware" value={field(identity.firmware, '—')} foot={identity.bootloader ? `boot ${identity.bootloader}` : 'Program version'} />
        <Stat
          label="FXS ports"
          value={state?.ports?.length ? `${portScore}/${state.ports.length}` : '2'}
          foot={state?.ports?.length ? (state?.firmware === 'v2' ? 'With an extension' : 'Registered') : 'Two analog lines'}
          tone={state?.ports?.length && portScore < state.ports.length ? 'var(--warning)' : undefined}
        />
        <Stat label="Uptime" value={field(identity.uptime, '—')} foot={identity.serial ? `S/N ${identity.serial}` : 'Since last restart'} />
      </div>

      <Card title="Ports" subtitle="One analog telephone per port; each is its own SIP registration">
        {state?.ports?.length ? (
          <div className="grid two">
            {state.ports.map((port) => {
              const ok = /registered|ok|idle|on hook/i.test(port.registration || '');
              return (
                <Card key={port.port} title={`FXS ${port.port}`} subtitle={port.sipUser ? `Extension ${port.sipUser}` : 'No extension reported'}>
                  <div className="stack">
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={ok ? 'success' : 'warning'} dot={ok ? 'live' : 'warn'}>
                        {field(port.registration, 'not reported')}
                      </Badge>
                      {port.hook ? <Badge tone="neutral">{port.hook}</Badge> : null}
                    </div>
                    <p className="tiny dim">
                      {ok
                        ? 'Registered with the switch. A call to this extension rings the telephone on this port.'
                        : port.registration === 'no SIP user'
                          ? 'No extension is configured on this port. Send it a Telno profile from Estate.'
                          : 'Not registered. Send a Telno profile from Estate, then reboot the adaptor.'}
                    </p>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty icon="phone" title={live ? 'This firmware did not report port state' : 'Ports not read'}>
            {live
              ? 'The unit answered, but its status page carries no per-port registration. The SIP account below is what it will register with.'
              : `Nothing was read because ${whyNotLive}. The ports are reported again as soon as the unit answers.`}
          </Empty>
        )}
      </Card>

      <Card title="SIP accounts" subtitle="What the adaptor registers as, per port" bodyClass="tight">
        {state?.accounts?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Extension</th>
                  <th>SIP server</th>
                  <th>Display name</th>
                  <th>Local port</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {state.accounts.map((account) => (
                  <tr key={account.port}>
                    <td className="tiny">FXS {account.port}</td>
                    <td className="tiny mono">{field(account.user, '—')}</td>
                    <td className="tiny mono">{field(account.server, '—')}</td>
                    <td className="tiny">{field(account.name, '—')}</td>
                    <td className="tiny mono">{field(account.localPort, '—')}</td>
                    <td>{account.active ? <Badge tone={/1|yes|enabled/i.test(account.active) ? 'success' : 'neutral'}>{account.active}</Badge> : <span className="tiny dim">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 16 }}>
            <p className="tiny dim" style={{ margin: 0 }}>
              {live
                ? `No account rows were readable. ${state?.sip?.exists === false ? 'The unit reports no SIP profile at all — provision it from Estate.' : 'Provision it from Estate to fill both ports.'}`
                : `Not read because ${whyNotLive}.`}
            </p>
          </div>
        )}
      </Card>

      <div className="grid two">
        <Card title="Network" subtitle="Where the unit sits on the LAN">
          {state?.network ? (
            <div className="stack">
              {[
                ['Address', state.network.ip],
                ['Subnet mask', state.network.mask],
                ['Gateway', state.network.gateway],
                ['DNS', state.network.dns],
                ['Addressing', state.network.dhcp],
              ].map(([label, value]) => (
                <div key={label} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="tiny dim">{label}</span>
                  <span className="tiny mono">{field(value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="tiny dim" style={{ margin: 0 }}>
              {live ? "Not readable from this unit's pages." : `Not read because ${whyNotLive}.`}{' '}
              {identity.ip ? `It reports itself at ${identity.ip}.` : ''}
            </p>
          )}
        </Card>

        <Card title="Provisioning" subtitle="How this unit gets its Telno identity">
          {provisioning ? (
            <div className="stack">
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="tiny dim">Config server</span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="tiny mono">{provisioning.server}</span>
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(provisioning.server, 'Server address')} aria-label="Copy the config server address" />
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="tiny dim">Voice path</span>
                <span className="tiny mono">
                  {provisioning.voice
                    ? provisioning.voice.sipEdge
                      ? `SIP → ${provisioning.voice.sipEdge} → Cantus ${provisioning.voice.port}/udp`
                      : `Cantus ${provisioning.voice.port}/udp (no SIP edge)`
                    : `SIP ${provisioning.sipDomain}:${provisioning.sipPort}`}
                </span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="tiny dim">File for this unit</span>
                <span className="tiny mono">{provisioning.fileUrl ? provisioning.fileUrl.split('/').pop() : 'needs a MAC on the inventory row'}</span>
              </div>
              {provisioning.voice?.note ? <p className="tiny dim" style={{ margin: 0 }}>{provisioning.voice.note}</p> : null}
              <p className="tiny dim" style={{ margin: 0 }}>
                Add the unit in <Link to="/estate">Estate</Link> as an <span className="mono">ata</span>, then send it this config. It fetches its
                port, the display name and its check-in token in one reboot.
              </p>
            </div>
          ) : (
            <p className="tiny dim" style={{ margin: 0 }}>Provisioning is disabled on this deployment.</p>
          )}
        </Card>
      </div>

      <Card
        title="Diagnostics"
        subtitle="What the platform could read, and where it came from"
        actions={<Button size="sm" icon="terminal" onClick={() => setShowDiagnostics(true)}>Open</Button>}
      >
        <div className="row wrap" style={{ gap: 8 }}>
          {sources.length ? (
            sources.map(([name, result]) => (
              <Badge key={name} tone={result === 'ok' ? 'success' : result === 'none' || result === 'unavailable' ? 'neutral' : 'warning'}>
                {name}: {result}
              </Badge>
            ))
          ) : (
            <span className="tiny dim">Not signed in, so only the unauthenticated endpoints were read.</span>
          )}
          {state?.system?.voiceImage ? <Badge tone="neutral">voice image {state.system.voiceImage}</Badge> : null}
        </div>
      </Card>

      {showDiagnostics ? (
        <Modal
          title="Diagnostics"
          subtitle={`${state?.target?.label || ''} · probed in ${state?.tookMs ?? 0} ms`}
          onClose={() => setShowDiagnostics(false)}
          wide
          footer={<Button variant="primary" onClick={() => setShowDiagnostics(false)}>Close</Button>}
        >
          <div className="stack">
            <p className="tiny dim">
              This firmware cannot be read with curl: it writes two status lines per response and prints its CGI shebang where a header belongs. The client
              parses the raw bytes, which is why the fields above exist at all.
            </p>
            <pre className="mono tiny" style={{ ...mono, maxHeight: 420, overflow: 'auto' }}>
              {JSON.stringify(
                {
                  target: state?.target,
                  state: state?.state,
                  authenticated: state?.authenticated,
                  lock: state?.lock,
                  system: state?.system,
                  sip: state?.sip,
                  identity: state?.identity,
                  network: state?.network,
                  ports: state?.ports,
                  accounts: state?.accounts,
                  sources: state?.sources,
                  notes: state?.notes,
                },
                null,
                2
              )}
            </pre>
          </div>
        </Modal>
      ) : null}

      {confirmReboot ? (
        <Modal
          title="Reboot the adaptor?"
          subtitle="Both analog lines drop for about a minute"
          onClose={() => setConfirmReboot(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmReboot(false)}>Cancel</Button>
              <Button variant="danger" loading={busy === 'reboot'} onClick={reboot}>Reboot now</Button>
            </>
          }
        >
          <p className="tiny dim" style={{ margin: 0 }}>
            The unit restarts immediately. Anything in progress on either FXS port is cut, and the console has to sign in again afterwards.
          </p>
        </Modal>
      ) : null}
    </>
  );
}
