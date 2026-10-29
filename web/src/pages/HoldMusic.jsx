import { useEffect, useState } from 'react';
import { api, relativeTime } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Loading,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '../ui.jsx';

/**
 * Hold music, written rather than licensed.
 *
 * The form is the whole feature: type what a caller should hear, pick a bed,
 * press Generate, listen. Applying it is a separate press because a generated
 * track is a draft — and because the switch is live, so silence is a decision
 * nobody should make by accident.
 */

const LENGTHS = [
  { value: 30, label: '30 seconds' },
  { value: 45, label: '45 seconds' },
  { value: 60, label: '1 minute' },
  { value: 90, label: '1½ minutes' },
  { value: 120, label: '2 minutes' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
];

const STARTERS = [
  'Thank you for holding. Your call is important to us and someone will be with you shortly.',
  'Thanks for waiting. Our team is helping another customer and will pick up in a moment.',
  'You have reached our office. We are open Monday to Friday, nine to six, Eastern time.',
];

/** Words per minute at the synthesizer's default pace, plus a beat per pause. */
const estimate = (text) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  const pauses = (String(text).match(/[,;:.]/g) || []).length;
  return Math.round((words / 165) * 60 + pauses * 0.22);
};

const duration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

export default function HoldMusic() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [playing, setPlaying] = useState(null);
  const [form, setForm] = useState({ name: '', message: '', style: 'calm', voice: 'slt', seconds: 60 });

  const load = async () => {
    try {
      const result = await api.get('/hold-music');
      setData(result);
      // The form follows the install's voice default and the applied style, so a
      // second track sounds like the one already on the switch.
      setForm((current) => ({
        ...current,
        voice: current.voice || result.status?.defaultVoice || 'slt',
        style: result.status?.applied?.style || current.style,
      }));
    } catch (err) {
      toast.error('Could not load hold music', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const generate = async () => {
    setBusy('generate');
    try {
      const result = await api.post('/hold-music', {
        name: form.name,
        message: form.message,
        style: form.style,
        voice: form.voice,
        seconds: Number(form.seconds),
      });
      setData((current) => ({ ...current, items: [result.item, ...(current?.items || []).filter((entry) => entry.id !== result.item.id)] }));
      setPlaying(result.item);
      const words = result.render.announcements;
      toast.success(
        `${result.item.name} is ready`,
        words ? `${duration(result.render.seconds)} — the message plays ${words} time${words > 1 ? 's' : ''}` : 'Music only, no message'
      );
    } catch (err) {
      toast.error('Could not generate that track', err.message);
    } finally {
      setBusy('');
    }
  };

  const apply = async (item) => {
    setBusy(item.id);
    try {
      const result = await api.post(`/hold-music/${item.id}/apply`, {});
      setData((current) => ({
        ...current,
        items: (current?.items || []).map((entry) => ({ ...entry, applied: entry.id === item.id })),
        status: result.status,
      }));
      if (result.apply?.error) {
        toast.error('Saved, but the switch did not reload', result.apply.error);
      } else if (result.apply?.written === false) {
        toast.success(`${item.name} is the hold music`, 'This install has no switch attached, so nothing was reloaded.');
      } else {
        toast.success(`${item.name} is the hold music`, `Playing on class “${result.status.clazz}” — parked callers and softphone hold both hear it.`);
      }
    } catch (err) {
      toast.error('Could not apply that track', err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete “${item.name}”? A copy on the switch is replaced by its default hold music if this one is applied.`)) return;
    setBusy(item.id);
    try {
      const result = await api.del(`/hold-music/${item.id}`);
      setData((current) => ({ ...current, items: result.items, status: result.status }));
      if (playing?.id === item.id) setPlaying(null);
      toast.success('Deleted');
    } catch (err) {
      toast.error('Could not delete', err.message);
    } finally {
      setBusy('');
    }
  };

  if (loading) return <Loading rows={4} />;

  const status = data?.status;
  const speech = status?.voice;
  const items = data?.items || [];
  const words = estimate(form.message);
  const trackSeconds = Number(form.seconds);
  const fits = !words || words + 4 < trackSeconds;

  return (
    <>
      <PageHeader
        title="Hold music"
        subtitle="Write the announcement, choose the bed, and the switch plays it — no music licence, no upload"
      />

      <div className="grid two">
        <Card title="Write a track" subtitle="The message is spoken once at the start, then every 45 seconds">
          <div className="field">
            <label className="label" htmlFor="moh-name">Name</label>
            <Input
              id="moh-name"
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Front desk — after hours"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="moh-message">
              Message <span className="dim">— spoken by the switch, {(form.message || '').length}/800</span>
            </label>
            <Textarea
              id="moh-message"
              rows={5}
              value={form.message}
              maxLength={800}
              onChange={(event) => set({ message: event.target.value })}
              placeholder="Thank you for holding. Someone will be with you shortly."
            />
            <p className="tiny dim" style={{ marginTop: 6 }}>
              {words ? `About ${words}s spoken. ` : 'Leave it empty for music with no announcement. '}
              {!fits ? (
                <strong style={{ color: 'var(--warning, #f0b429)' }}>
                  That message is longer than the track — it will be cut off. Choose a longer track.
                </strong>
              ) : null}
            </p>
            {!form.message ? (
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                {STARTERS.map((starter, index) => (
                  <Button key={starter} size="sm" variant="ghost" onClick={() => set({ message: starter })}>
                    Starter {index + 1}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="row wrap" style={{ gap: 12 }}>
            <div style={{ flex: '1 1 200px' }}>
              <Select label="Background" value={form.style} onChange={(event) => set({ style: event.target.value })}>
                {(status?.styles || []).map((style) => (
                  <option key={style.value} value={style.value}>{style.label}</option>
                ))}
              </Select>
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <Select
                label="Voice"
                value={form.voice}
                onChange={(event) => set({ voice: event.target.value })}
                disabled={!speech?.available}
              >
                {(data?.speeches?.voices || []).map((voice) => (
                  <option key={voice.value} value={voice.value}>{voice.label}</option>
                ))}
              </Select>
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <Select label="Track length" value={form.seconds} onChange={(event) => set({ seconds: Number(event.target.value) })}>
                {LENGTHS.map((length) => (
                  <option key={length.value} value={length.value}>{length.label}</option>
                ))}
              </Select>
            </div>
          </div>

          {speech?.available ? (
            <p className="tiny dim" style={{ marginTop: 10 }}>{speech.detail}.</p>
          ) : (
            <p className="tiny" style={{ marginTop: 10, color: 'var(--warning, #f0b429)' }}>
              {speech?.detail}. You can still generate music without a message.
            </p>
          )}

          <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
            <Button
              variant="primary"
              icon="sparkle"
              loading={busy === 'generate'}
              onClick={generate}
              disabled={busy === 'generate' || (!!form.message && !speech?.available)}
            >
              Generate track
            </Button>
            {form.message && !speech?.available ? null : (
              <span className="tiny dim">Rendering takes a second; the player opens when it is done.</span>
            )}
          </div>
        </Card>

        <Card title="What the caller hears" subtitle={playing ? playing.name : 'Nothing selected yet'}>
          {playing ? (
            <>
              <audio
                key={playing.id}
                src={playing.audioUrl}
                controls
                autoPlay
                style={{ width: '100%', marginBottom: 12 }}
              />
              <dl className="kv">
                <dt>Length</dt>
                <dd>{duration(playing.seconds)}</dd>
                <dt>Background</dt>
                <dd>{status?.styles?.find((style) => style.value === playing.style)?.label || playing.style}</dd>
                <dt>Message</dt>
                <dd className="tiny" style={{ maxWidth: 320 }}>
                  {playing.message || <span className="dim">music only</span>}
                </dd>
                <dt>On the switch</dt>
                <dd>
                  {playing.applied ? (
                    <Badge tone="success" dot>applied</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" loading={busy === playing.id} onClick={() => apply(playing)}>
                      Apply this track
                    </Button>
                  )}
                </dd>
              </dl>
            </>
          ) : (
            <Empty icon="volume" title="No track selected">
              Generate one, or press play on a saved track below.
            </Empty>
          )}

          <p className="tiny dim" style={{ marginTop: 12 }}>
            Applied music is written into the switch's own <code>musiconhold.conf</code> and the module is
            reloaded, so a caller already in the parking lot hears it on their next hold. The file lives on the
            data volume, next to the database, so an image upgrade keeps it.
          </p>
        </Card>
      </div>

      <Card
        title="Saved tracks"
        subtitle={status?.applied ? `Applied: ${status.applied.name}` : 'Nothing applied — the switch is playing its built-in hold music'}
        bodyClass="tight"
      >
        {items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Background</th>
                  <th>Length</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <button
                          className="btn ghost sm"
                          onClick={() => setPlaying(item)}
                          aria-label={`Play ${item.name}`}
                        >
                          ▶
                        </button>
                        <span className="truncate" style={{ maxWidth: 240 }}>{item.name}</span>
                        {item.applied ? <Badge tone="success" dot>applied</Badge> : null}
                      </div>
                    </td>
                    <td className="tiny muted">{status?.styles?.find((style) => style.value === item.style)?.label || item.style}</td>
                    <td className="tiny muted">{duration(item.seconds)}</td>
                    <td className="tiny dim">{relativeTime(item.createdAt)}</td>
                    <td className="align-right">
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {item.applied ? null : (
                          <Button size="sm" variant="ghost" loading={busy === item.id} onClick={() => apply(item)}>
                            Apply
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          loading={busy === item.id}
                          onClick={() => remove(item)}
                          aria-label={`Delete ${item.name}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="volume" title="No hold music yet">
            Generate a track above. Until then the switch plays its own default, which is silence on a fresh
            install.
          </Empty>
        )}
      </Card>
    </>
  );
}
