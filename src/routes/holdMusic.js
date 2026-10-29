import { createReadStream, existsSync, statSync } from 'node:fs';
import { db_, newId, now } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logEvent } from '../lib/audit.js';
import { applyConfiguration } from '../telephony/index.js';
import {
  DEFAULT_SECONDS,
  DEFAULT_STYLE,
  MAX_MESSAGE,
  MAX_SECONDS,
  MIN_SECONDS,
  STYLES,
  deleteHoldMusic,
  getHoldMusic,
  holdMusicStatus,
  listHoldMusic,
  renderHoldMusic,
  saveHoldMusic,
  setAppliedHoldMusic,
  trackFile,
} from '../lib/holdMusic.js';
import { DEFAULT_VOICE, VOICES, speak } from '../lib/speech.js';
import * as v from '../lib/validate.js';

/**
 * The hold music generator, as an API.
 *
 * Writing a track and putting it on the switch are separate calls on purpose: a
 * generated file is a draft until somebody listens to it, and an install should
 * not go quiet because an operator pressed Generate and then closed the tab.
 */

const styleValues = STYLES.map((entry) => entry.value);
const voiceValues = VOICES.map((entry) => entry.value);

const nameFor = (raw, message) => {
  const given = String(raw || '').trim();
  if (given) return given.slice(0, 60);
  const words = String(message || '').trim().split(/\s+/).slice(0, 6).join(' ');
  return (words || 'Hold music').slice(0, 60);
};

export default async function holdMusicRoutes(app) {
  app.addHook('preHandler', async (request) => {
    if (request.method === 'OPTIONS') return;
    await app.authenticate(request);
  });

  app.get('/hold-music', async () => ({
    status: holdMusicStatus(),
    items: listHoldMusic(),
    // What the console shows under the message box, so an operator can see that
    // the track will be long enough for the words before generating it.
    speeches: { voices: VOICES.filter((voice) => voiceValues.includes(voice.value)), defaultVoice: DEFAULT_VOICE },
  }));

  /** Render one track and keep it as a draft. */
  app.post('/hold-music', { preHandler: app.requireRole('owner', 'operator') }, async (request, reply) => {
    const body = request.body || {};
    const message = String(v.str(body.message, { name: 'message', max: MAX_MESSAGE, required: false, fallback: '' }) || '').trim();
    const style = v.str(body.style, { name: 'style', max: 20, required: false, fallback: DEFAULT_STYLE });
    if (!styleValues.includes(style)) throw badRequest(`Unknown style. Use one of: ${styleValues.join(', ')}`);
    const voice = v.str(body.voice, { name: 'voice', max: 20, required: false, fallback: DEFAULT_VOICE });
    if (!voiceValues.includes(voice)) throw badRequest(`Unknown voice. Use one of: ${voiceValues.join(', ')}`);
    const seconds = v.integer(body.seconds, {
      name: 'seconds',
      min: MIN_SECONDS,
      max: MAX_SECONDS,
      required: false,
      fallback: DEFAULT_SECONDS,
    });
    const existing = body.id ? getHoldMusic(body.id) : null;
    if (body.id && !existing) throw notFound('No hold music track with that id');
    const name = nameFor(body.name ?? existing?.name, message);

    // Speech first: if the synthesizer is missing or refuses the text there is
    // no point rendering a bed, and the operator gets the reason rather than a
    // track of music with no words in it.
    let audio = null;
    if (message) {
      const spoken = speak({ text: message, voice });
      if (!spoken.ok) {
        throw badRequest(
          `${spoken.error}. The generator needs the speech engine in the image — rebuild it, or leave the message empty to produce music only.`
        );
      }
      audio = spoken;
    }

    let rendered;
    try {
      rendered = renderHoldMusic({ message, style, seconds, audio });
    } catch (err) {
      throw badRequest(`The generator could not render that track: ${err.message}`);
    }

    const id = existing?.id || newId('moh_');
    const item = saveHoldMusic({
      id,
      name,
      message,
      style,
      voice,
      seconds: Math.round(rendered.seconds),
      buffer: rendered.buffer,
    });

    logEvent({
      actor: request.account.email,
      action: 'hold_music.generated',
      subject: name,
      detail: `${Math.round(rendered.seconds)}s, ${style}, ${rendered.announcements} announcement(s)${
        audio ? `, voice ${audio.voice}` : ', music only'
      }`,
      ip: request.ip,
    });

    reply.status(existing ? 200 : 201);
    return {
      item,
      status: holdMusicStatus(),
      render: {
        seconds: rendered.seconds,
        announcements: rendered.announcements,
        messageSeconds: rendered.messageSeconds,
        peak: Number(rendered.peak.toFixed(3)),
      },
    };
  });

  /** The file itself, for the console's player. */
  app.get('/hold-music/:id/audio', async (request, reply) => {
    const item = getHoldMusic(request.params?.id);
    if (!item) throw notFound('No hold music track with that id');
    const file = trackFile(item.id);
    // Streamed from the data volume, which is outside the console's static root
    // on purpose: the file is served only through this authenticated route.
    if (!existsSync(file)) throw notFound('That track has no file — regenerate it');
    const stat = statSync(file);
    return reply
      .header('cache-control', 'private, max-age=0, must-revalidate')
      .header('content-length', stat.size)
      .type('audio/wav')
      .send(createReadStream(file));
  });

  /** Make this the track the switch plays, and reload the module that reads it. */
  app.post('/hold-music/:id/apply', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const item = getHoldMusic(request.params?.id);
    if (!item) throw notFound('No hold music track with that id');
    if (!setAppliedHoldMusic(item.id)) throw notFound('No hold music track with that id');

    let switchResult = null;
    try {
      switchResult = await applyConfiguration(request.account.email);
    } catch (err) {
      // The row is already applied: the next change or the next boot writes the
      // same configuration, so this is reported rather than rolled back.
      logEvent({
        actor: request.account.email,
        action: 'hold_music.apply_failed',
        subject: item.name,
        detail: err.message,
        ip: request.ip,
      });
      switchResult = { error: err.message };
    }

    logEvent({
      actor: request.account.email,
      action: 'hold_music.applied',
      subject: item.name,
      detail: `class ${config.parking.mohClass}, ${item.seconds}s`,
      ip: request.ip,
    });

    return { item: getHoldMusic(item.id), status: holdMusicStatus(), apply: switchResult };
  });

  app.delete('/hold-music/:id', { preHandler: app.requireRole('owner', 'operator') }, async (request) => {
    const item = getHoldMusic(request.params?.id);
    if (!item) throw notFound('No hold music track with that id');
    // Deleting the applied track leaves the class pointing at a directory that
    // is gone, so the switch is told to fall back before the file disappears.
    if (item.applied) {
      db_.run('UPDATE hold_music SET applied = 0, updated_at = ? WHERE applied = 1', [now()]);
    }
    deleteHoldMusic(item.id);
    if (item.applied) await applyConfiguration(request.account.email);
    logEvent({
      actor: request.account.email,
      action: 'hold_music.deleted',
      subject: item.name,
      detail: item.applied ? 'was applied' : 'draft',
      ip: request.ip,
    });
    return { deleted: true, status: holdMusicStatus(), items: listHoldMusic() };
  });
}
