import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

/* --------------------------------------------------------------------- icons */

const ICONS: Record<string, string> = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  phone: 'M6.5 3h3l1.5 4-2 1.5a11 11 0 0 0 5 5L15.5 11l4 1.5v3A2.5 2.5 0 0 1 17 18C10.4 18 4 11.6 4 5a2 2 0 0 1 2.5-2z',
  layers: 'M12 3 3 8l9 5 9-5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  book: 'M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM17 20V7M8 8h5M8 12h5',
  key: 'M14 4a6 6 0 1 0-5.2 9L4 17.8V20h3l1-1v-2h2v-2h2l1.3-1.3A6 6 0 0 0 14 4z',
  pulse: 'M3 12h4l2-6 3 12 2.5-6H21',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.2 2 2 0 1 1 14 4.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.6 1z',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0-2 5.3M20 5v6h-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  check: 'M4 12l5 5L20 6',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  moon: 'M20 14a8 8 0 0 1-9-11 8 8 0 1 0 9 11z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h4',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17h.01',
  edit: 'M4 20h4l11-11-4-4L4 16v4zM14 5l4 4',
  chevron: 'M9 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-8 8M18 14v6H4V6h6',
  download: 'M12 3v12M7 11l5 5 5-5M4 21h16',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8z',
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  const path = ICONS[name] ?? ICONS.grid!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d={path} />
    </svg>
  );
}

/* ------------------------------------------------------------------- toasts */

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'err' | 'warn' | 'info';
}

const ToastContext = createContext<{ push: (message: string, tone?: Toast['tone']) => void }>({
  push: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++seq.current;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, tone === 'err' ? 7000 : tone === 'warn' ? 6500 : 4200);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === 'info' ? '' : toast.tone}`}>
            <span>{toast.message}</span>
            <button
              className="close"
              aria-label="Dismiss"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ------------------------------------------------------------------ controls */

export function Button({
  variant,
  size,
  loading,
  icon,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  loading?: boolean;
  icon?: string;
}) {
  const classes = ['btn', variant ?? '', size ?? ''].filter(Boolean).join(' ');
  return (
    <button {...rest} className={classes} disabled={rest.disabled || loading}>
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

export function Field({
  label,
  help,
  children,
  span,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  span?: boolean;
}) {
  return (
    <div className={`field${span ? ' span-2' : ''}`}>
      <label>{label}</label>
      {children}
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

export function Badge({
  tone,
  dot,
  children,
}: {
  tone?: 'ok' | 'warn' | 'err' | 'accent';
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone ?? ''}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'accent'> = {
  online: 'ok',
  offline: 'warn',
  pending: 'accent',
  revoked: 'err',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'accent'} dot>
      {status}
    </Badge>
  );
}

/* -------------------------------------------------------------------- modals */

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(760px, 100%)' } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <div className="muted small">{subtitle}</div> : null}
          </div>
          <button className="btn ghost icon spacer" onClick={onClose} aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dim" style={{ margin: 0 }}>
        {message}
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------------------- states */

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name="layers" size={22} />
      <strong>{title}</strong>
      {message ? <span className="small">{message}</span> : null}
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card-body stack">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ width: `${92 - index * 9}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="callout err">
      <strong>Something went wrong</strong>
      <span>{message}</span>
      {onRetry ? (
        <div>
          <Button size="sm" onClick={onRetry} icon="refresh">
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- pieces */

export function Copyable({ value, label }: { value: string; label?: string }) {
  const { push } = useToast();
  return (
    <span className="row" style={{ gap: 6 }}>
      <code className="mono">{value}</code>
      <button
        className="btn ghost icon sm"
        aria-label={label ?? 'Copy'}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            push('Copied to clipboard', 'ok');
          } catch {
            push('Clipboard unavailable — select the value to copy it', 'err');
          }
        }}
      >
        <Icon name="copy" size={13} />
      </button>
    </span>
  );
}

export function CodeBlock({ value }: { value: string }) {
  return <pre className="code">{value}</pre>;
}

/* ---------------------------------------------------------------------- time */

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const delta = Math.round((Date.now() - then) / 1000);
  if (delta < 45) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)} h ago`;
  return `${Math.round(delta / 86400)} d ago`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ------------------------------------------------------------------ async UI */

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(options.enabled !== false);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (options.enabled === false) return;
    setLoading(true);
    setError(null);
    load()
      .then((value) => {
        if (alive.current) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (alive.current) {
          setError(err instanceof Error ? err.message : 'Request failed');
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}
