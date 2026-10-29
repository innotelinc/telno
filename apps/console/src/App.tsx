import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CantusStatus, SessionUser } from '@telno/shared';
import { api, ApiError } from './api';
import { Badge, Button, Icon, ToastProvider, useToast } from './ui';
import { Login } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { DevicesPage } from './pages/Devices';
import { LinesPage } from './pages/Lines';
import { DirectoryPage } from './pages/Directory';
import { ProvisioningPage } from './pages/Provisioning';
import { DiagnosticsPage } from './pages/Diagnostics';
import { SettingsPage } from './pages/Settings';

export type PageKey =
  | 'overview'
  | 'devices'
  | 'lines'
  | 'directory'
  | 'provisioning'
  | 'diagnostics'
  | 'settings';

const PAGES: Array<{
  key: PageKey;
  label: string;
  icon: string;
  group: string;
  title: string;
  subtitle: string;
}> = [
  {
    key: 'overview',
    label: 'Overview',
    icon: 'grid',
    group: 'Monitor',
    title: 'Overview',
    subtitle: 'Fleet health, voice status and recent platform activity',
  },
  {
    key: 'devices',
    label: 'Devices',
    icon: 'phone',
    group: 'Monitor',
    title: 'Devices',
    subtitle: 'T750 desk phones and HT802 analog adapters',
  },
  {
    key: 'lines',
    label: 'Lines',
    icon: 'layers',
    group: 'Configure',
    title: 'Lines',
    subtitle: 'Extensions, address of record and cantus routing',
  },
  {
    key: 'directory',
    label: 'Directory',
    icon: 'book',
    group: 'Configure',
    title: 'Directory',
    subtitle: 'People, numbers and the shared phonebook',
  },
  {
    key: 'provisioning',
    label: 'Provisioning',
    icon: 'key',
    group: 'Configure',
    title: 'Provisioning',
    subtitle: 'Enrollment codes, signed configuration and key rotation',
  },
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    icon: 'pulse',
    group: 'Operate',
    title: 'Diagnostics',
    subtitle: 'cantus health, routing evaluation and live path probes',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'gear',
    group: 'Operate',
    title: 'Settings',
    subtitle: 'Organisation, voice node and operator access',
  },
];

const pageFromHash = (): PageKey => {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (PAGES.find((p) => p.key === raw)?.key ?? 'overview') as PageKey;
};

function Shell({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [page, setPage] = useState<PageKey>(pageFromHash);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('telno.theme') as 'dark' | 'light') ?? 'dark',
  );
  const [cantus, setCantus] = useState<CantusStatus | null>(null);
  const { push } = useToast();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('telno.theme', theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((key: PageKey) => {
    window.location.hash = `#/${key}`;
    setPage(key);
  }, []);

  useEffect(() => {
    api
      .cantusStatus()
      .then(setCantus)
      .catch(() => setCantus(null));
  }, [page]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = PAGES.find((p) => p.key === page)!;
  const groups = useMemo(() => {
    const map = new Map<string, typeof PAGES>();
    for (const item of PAGES) {
      map.set(item.group, [...(map.get(item.group) ?? []), item]);
    }
    return [...map.entries()];
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="phone" size={17} />
          </div>
          <div className="brand-text">
            <strong>Telno</strong>
            <span>Platform 2026</span>
          </div>
        </div>

        <nav className="nav" aria-label="Sections">
          {groups.map(([group, items]) => (
            <div key={group} style={{ display: 'contents' }}>
              <div className="nav-group">{group}</div>
              {items.map((item) => (
                <button
                  key={item.key}
                  className="nav-item"
                  aria-current={page === item.key ? 'page' : undefined}
                  onClick={() => navigate(item.key)}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="row" style={{ gap: 6 }}>
            <Icon name="shield" size={13} />
            <span>{user.displayName}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Icon name="bolt" size={13} />
            <span>{cantus?.available ? 'cantus control online' : 'cantus unreachable'}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{current.title}</h1>
            <div className="sub">{current.subtitle}</div>
          </div>
          <div className="topbar-right">
            <button
              className="btn ghost sm"
              onClick={() => setPaletteOpen(true)}
              title="Search and jump (Ctrl K)"
            >
              <Icon name="search" size={14} />
              <span className="mono" style={{ fontSize: 11 }}>
                Ctrl K
              </span>
            </button>
            {cantus ? (
              <Badge tone={cantus.available ? 'ok' : 'err'} dot>
                cantus {cantus.available ? 'ready' : 'down'}
              </Badge>
            ) : null}
            <button
              className="btn ghost icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle colour scheme"
              title="Toggle colour scheme"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>
            <Button
              variant="ghost"
              size="sm"
              icon="logout"
              onClick={async () => {
                try {
                  await api.logout();
                } catch {
                  /* the session is going away either way */
                }
                push('Signed out', 'ok');
                onSignOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </header>

        <main className="content">
          {page === 'overview' && <OverviewPage onNavigate={navigate} />}
          {page === 'devices' && <DevicesPage />}
          {page === 'lines' && <LinesPage />}
          {page === 'directory' && <DirectoryPage />}
          {page === 'provisioning' && <ProvisioningPage />}
          {page === 'diagnostics' && <DiagnosticsPage />}
          {page === 'settings' && <SettingsPage user={user} />}
        </main>
      </div>

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={(key) => {
            navigate(key);
            setPaletteOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function CommandPalette({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (key: PageKey) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = PAGES.filter((p) =>
    `${p.label} ${p.subtitle}`.toLowerCase().includes(query.toLowerCase()),
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Jump to">
        <input
          ref={inputRef}
          value={query}
          placeholder="Where do you want to go?"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, results.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (event.key === 'Enter' && results[index]) onNavigate(results[index].key);
          }}
        />
        <ul>
          {results.map((item, i) => (
            <li key={item.key}>
              <button aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => onNavigate(item.key)}>
                <Icon name={item.icon} size={15} />
                {item.label}
                <span className="hint">{item.group}</span>
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            <li style={{ padding: '14px 12px' }} className="muted small">
              No section matches “{query}”.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .session()
      .then((res) => setUser(res.user))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status !== 401) {
          console.warn('session check failed', error.message);
        }
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="login">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="muted">Connecting to the Telno control plane…</div>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      {user ? (
        <Shell user={user} onSignOut={() => setUser(null)} />
      ) : (
        <Login onSignedIn={setUser} />
      )}
    </ToastProvider>
  );
}
