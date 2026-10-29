import { useMemo, useState } from 'react';
import type { DirectoryEntry } from '@telno/shared';
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
  useAsync,
  useToast,
} from '../ui';

export function DirectoryPage() {
  const directory = useAsync<{ entries: DirectoryEntry[] }>(() => api.directory(), []);
  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [editing, setEditing] = useState<DirectoryEntry | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DirectoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const entries = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (directory.data?.entries ?? []).filter((entry) => {
      if (onlyFavorites && !entry.favorite) return false;
      if (!term) return true;
      return `${entry.displayName} ${entry.number} ${entry.extension ?? ''} ${entry.email ?? ''} ${entry.company ?? ''}`
        .toLowerCase()
        .includes(term);
    });
  }, [directory.data, query, onlyFavorites]);

  const toggleFavorite = async (entry: DirectoryEntry) => {
    try {
      await api.updateEntry(entry.id, { favorite: !entry.favorite });
      directory.reload();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not update the entry', 'err');
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteEntry(deleting.id);
      push('Entry removed', 'ok');
      setDeleting(null);
      directory.reload();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not remove the entry', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Phonebook</h2>
          <span className="hint">{directory.data?.entries.length ?? 0} entries</span>
          <div className="spacer" />
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Search people, numbers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="chip"
            aria-pressed={onlyFavorites}
            onClick={() => setOnlyFavorites((v) => !v)}
          >
            Favourites
          </button>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            Add entry
          </Button>
        </div>

        {directory.loading && !directory.data ? (
          <SkeletonRows rows={5} />
        ) : directory.error ? (
          <div className="card-body">
            <ErrorBox message={directory.error} onRetry={directory.reload} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title={query || onlyFavorites ? 'Nothing matches' : 'The directory is empty'}
            message={
              query || onlyFavorites
                ? 'Clear the search or the favourites filter.'
                : 'Add people and numbers so devices and operators share one phonebook.'
            }
            action={
              !query && !onlyFavorites ? (
                <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
                  Add entry
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Name</th>
                  <th>Number</th>
                  <th>Ext</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ width: 30 }}>
                      <button
                        className="btn ghost icon sm"
                        aria-label={entry.favorite ? 'Remove favourite' : 'Mark favourite'}
                        onClick={() => toggleFavorite(entry)}
                      >
                        <span style={{ color: entry.favorite ? 'var(--warn)' : 'var(--text-faint)' }}>
                          <Icon name="bolt" size={14} />
                        </span>
                      </button>
                    </td>
                    <td className="strong">{entry.displayName}</td>
                    <td>
                      <Copyable value={entry.number} label={`Copy ${entry.number}`} />
                    </td>
                    <td className="mono">{entry.extension ?? '—'}</td>
                    <td className="small muted">{entry.email ?? '—'}</td>
                    <td className="small">
                      {entry.company ? <Badge>{entry.company}</Badge> : <span className="muted">—</span>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="edit"
                          onClick={() => setEditing(entry)}
                          aria-label={`Edit ${entry.displayName}`}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="trash"
                          onClick={() => setDeleting(entry)}
                          aria-label={`Remove ${entry.displayName}`}
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
        <EntryModal
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            directory.reload();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Remove ${deleting.displayName}?`}
          message="The entry disappears from the shared directory. Numbers and lines are unaffected."
          confirmLabel="Remove entry"
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={remove}
        />
      ) : null}
    </>
  );
}

function EntryModal({
  entry,
  onClose,
  onSaved,
}: {
  entry: DirectoryEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(entry?.displayName ?? '');
  const [number, setNumber] = useState(entry?.number ?? '');
  const [extension, setExtension] = useState(entry?.extension ?? '');
  const [email, setEmail] = useState(entry?.email ?? '');
  const [company, setCompany] = useState(entry?.company ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [favorite, setFavorite] = useState(entry?.favorite ?? false);
  const [busy, setBusy] = useState(false);
  const { push } = useToast();

  const submit = async () => {
    setBusy(true);
    const payload = {
      displayName: displayName.trim(),
      number: number.trim(),
      extension: extension.trim(),
      email: email.trim(),
      company: company.trim(),
      notes: notes.trim(),
      favorite,
    };
    try {
      if (entry) await api.updateEntry(entry.id, payload);
      else await api.createEntry(payload);
      push(entry ? 'Entry updated' : 'Entry added', 'ok');
      onSaved();
    } catch (error) {
      push(error instanceof Error ? error.message : 'Could not save the entry', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={entry ? 'Edit entry' : 'Add directory entry'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!displayName.trim() || !number.trim()}
            onClick={submit}
          >
            {entry ? 'Save changes' : 'Add entry'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" span>
          <input
            className="input"
            value={displayName}
            autoFocus
            placeholder="Amara Okafor"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Number">
          <input
            className="input mono"
            value={number}
            placeholder="+44 20 7946 0102"
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field label="Extension">
          <input
            className="input mono"
            value={extension}
            placeholder="102"
            onChange={(e) => setExtension(e.target.value)}
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={email}
            placeholder="amara@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Company">
          <input
            className="input"
            value={company}
            placeholder="Acme"
            onChange={(e) => setCompany(e.target.value)}
          />
        </Field>
        <Field label="Notes" span>
          <textarea
            className="textarea"
            rows={3}
            value={notes}
            placeholder="Anything an operator should know before dialling"
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
        Pin to favourites
      </label>
    </Modal>
  );
}
