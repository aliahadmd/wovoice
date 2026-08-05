import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError, adminApi, safeReturnTo, signInRedirect } from "./api";

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string;
      remove(widgetId: string): void;
      reset(widgetId: string): void;
    };
  }
}

type View = "overview" | "users" | "detail" | "audit";
type AccountState = "active" | "suspended" | "banned";

interface AdminSession {
  admin: { id: string; email: string; role: "admin" };
  session: { absoluteExpiresAt: number };
}

interface AccountStatus {
  state: AccountState;
  suspendedUntil: number | null;
  publicMessage: string | null;
}

interface UserSummary {
  id: string;
  email: string;
  role: "user" | "admin";
  status: AccountStatus;
  createdAt: number;
  lastActivityAt: number | null;
  sessionCount: number;
  todayAudioSeconds: number;
  quotaLimitAudioSeconds: number;
  usage90d: { audioSeconds: number; requests: number };
}

interface UserDetail extends UserSummary {
  verifiedAt: number;
  termsVersion: string;
  quota: {
    limitAudioSeconds: number;
    todayUsedAudioSeconds: number;
    overrideExpiresAt: number | null;
  };
  usage90d: { audioSeconds: number; requests: number; neurons: number };
  encryptedSyncMetadata: Array<{ type: string; count: number; encryptedBytes: number }>;
  sessions: Array<{ id: string; deviceName: string; createdAt: number; lastSeenAt: number }>;
  notifications: Array<{
    id: string;
    action: string;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: number;
    sentAt: number | null;
  }>;
}

interface Activity {
  id: string;
  type: string;
  requestId: string | null;
  statusCode: number | null;
  outcomeCode: string | null;
  model: string | null;
  audioSeconds: number | null;
  estimatedNeurons: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  itemCount: number | null;
  deviceName: string | null;
  createdAt: number;
}

interface AuditEvent {
  id: string;
  actorUserId: string | null;
  targetUserId: string | null;
  action: string;
  internalReason: string;
  beforeState: unknown;
  afterState: unknown;
  requestId: string;
  createdAt: number;
}

export function App() {
  return location.pathname.startsWith("/login") ? <LoginPage /> : <AdminPortal />;
}

function LoginPage() {
  const [siteKey, setSiteKey] = useState("");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading secure sign-in…");
  const [error, setError] = useState("");
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get("returnTo"));

  useEffect(() => {
    let active = true;
    adminApi<{ turnstileSiteKey: string }>("/auth/config")
      .then((value) => {
        if (!active) return;
        setSiteKey(value.turnstileSiteKey);
        setMessage("Enter your administrator email to receive a one-time code.");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Sign-in is unavailable.");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!siteKey || !widget.current) return;
    let cancelled = false;
    const mount = () => {
      if (cancelled || !widget.current || !window.turnstile) return;
      widgetId.current = window.turnstile.render(widget.current, {
        sitekey: siteKey,
        theme: "dark",
        size: "flexible",
        action: "admin_login",
        callback: (value: string) => { setToken(value); setError(""); },
        "expired-callback": () => { setToken(""); setError("The security check expired. Complete it again."); },
        "error-callback": () => { setToken(""); setError("The security check could not load. Check your connection."); },
      });
    };
    if (window.turnstile) mount();
    else {
      const existing = document.querySelector<HTMLScriptElement>("script[data-wovoice-turnstile]");
      const script = existing ?? document.createElement("script");
      if (!existing) {
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.wovoiceTurnstile = "true";
        document.head.append(script);
      }
      script.addEventListener("load", mount, { once: true });
    }
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
    };
  }, [siteKey]);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    if (!token) { setError("Complete the security check first."); return; }
    setBusy(true); setError(""); setMessage("Sending a secure code…");
    try {
      const value = await adminApi<{ challengeId: string }>("/auth/start", {
        method: "POST",
        csrf: false,
        body: { email, turnstileToken: token },
      });
      setChallengeId(value.challengeId);
      setMessage("If this address is an active administrator, a six-digit code has been sent.");
    } catch (reason) {
      setError(errorMessage(reason));
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
      setToken("");
    } finally { setBusy(false); }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("Verifying your administrator session…");
    try {
      await adminApi<AdminSession>("/auth/verify", {
        method: "POST",
        csrf: false,
        body: { challengeId, code },
      });
      location.replace(returnTo);
    } catch (reason) {
      setError(errorMessage(reason));
      setMessage("Enter the latest code from your email.");
    } finally { setBusy(false); }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <Brand />
        <p className="eyebrow">PRIVATE ADMINISTRATION</p>
        <h1 id="login-title">Sign in to WoVoice</h1>
        <p className="muted">{message}</p>
        {!challengeId ? (
          <form onSubmit={sendCode} className="login-form">
            <label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <div ref={widget} className="turnstile" aria-label="Security check" />
            {error && <Banner>{error}</Banner>}
            <button className="primary-button" disabled={busy || !token}>{busy ? "Sending…" : "Send one-time code"}</button>
          </form>
        ) : (
          <form onSubmit={verify} className="login-form">
            <label>Six-digit code<input className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))} required autoFocus /></label>
            {error && <Banner>{error}</Banner>}
            <button className="primary-button" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Open admin console"}</button>
            <button type="button" className="text-button" onClick={() => location.reload()}>Start again</button>
          </form>
        )}
        <p className="privacy-note">Protected by email verification, Turnstile, short-lived cookies, and the administrator role stored in WoVoice.</p>
      </section>
    </main>
  );
}

function AdminPortal() {
  const route = currentRoute();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [view, setView] = useState<View>(route.view);
  const [selectedUser, setSelectedUser] = useState<string | null>(route.userId);
  const [error, setError] = useState("");

  useEffect(() => {
    const restoreRoute = () => {
      const restored = currentRoute();
      setView(restored.view);
      setSelectedUser(restored.userId);
      setError("");
    };
    addEventListener("popstate", restoreRoute);
    return () => removeEventListener("popstate", restoreRoute);
  }, []);

  const loadSession = useCallback(async () => {
    try { setSession(await adminApi<AdminSession>("/session")); }
    catch (reason) {
      if (reason instanceof AdminApiError && reason.status === 401) signInRedirect();
      else setError(errorMessage(reason));
    }
  }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);

  function navigate(next: View, userId?: string) {
    const path = next === "overview" ? "/admin/" : next === "users" ? "/admin/users" : next === "audit" ? "/admin/audit" : `/admin/users/${encodeURIComponent(userId ?? "")}`;
    history.pushState({}, "", path);
    setView(next); setSelectedUser(userId ?? null); setError("");
  }

  async function logout() {
    try { await adminApi<void>("/logout", { method: "POST" }); }
    finally { location.replace("/login"); }
  }

  if (!session && !error) return <FullPageStatus title="Opening WoVoice Admin" detail="Verifying your secure browser session…" />;
  if (!session) return <FullPageStatus title="Admin console unavailable" detail={error} action={<button className="primary-button" onClick={signInRedirect}>Return to sign in</button>} />;

  const titles: Record<View, [string, string]> = {
    overview: ["SERVICE OPERATIONS", "Overview"],
    users: ["ACCOUNT MANAGEMENT", "Users"],
    detail: ["ACCOUNT DETAIL", "User"],
    audit: ["ACCOUNTABILITY", "Audit log"],
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <p className="eyebrow">ADMIN CONSOLE</p>
        <nav className="nav" aria-label="Admin sections">
          <NavButton active={view === "overview"} onClick={() => navigate("overview")} icon="⌁">Overview</NavButton>
          <NavButton active={view === "users" || view === "detail"} onClick={() => navigate("users")} icon="◎">Users</NavButton>
          <NavButton active={view === "audit"} onClick={() => navigate("audit")} icon="✓">Audit log</NavButton>
        </nav>
        <div className="identity"><span className="status-dot" /><div><strong>{session.admin.email}</strong><small>Email-verified session</small></div></div>
        <button className="logout-button" type="button" onClick={() => void logout()}>Sign out</button>
      </aside>
      <main className="main">
        <header className="topbar"><div><p className="eyebrow">{titles[view][0]}</p><h1>{titles[view][1]}</h1></div><span className="privacy-chip">Operational metadata only</span></header>
        {error && <Banner>{error}</Banner>}
        {view === "overview" && <Overview onError={setError} />}
        {view === "users" && <Users onOpen={(id) => navigate("detail", id)} onError={setError} />}
        {view === "detail" && selectedUser && <UserDetailView userId={selectedUser} onBack={() => navigate("users")} onError={setError} />}
        {view === "audit" && <Audit onError={setError} />}
      </main>
    </div>
  );
}

function Overview({ onError }: { onError(message: string): void }) {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    setData(null);
    adminApi<Record<string, unknown>>(`/overview?period=${period}`).then(setData).catch((reason) => onError(errorMessage(reason)));
  }, [period, onError]);
  if (!data) return <LoadingCards />;
  const users = data.users as { registered: number; active: number; suspended: number; banned: number; newInPeriod: number };
  const transcription = data.transcription as { succeeded: number; failed: number; successRate: number | null; audioSeconds: number; quotaRejections: number; medianLatencyMs: number | null };
  const usage = data.usage as { estimatedCostUsd: number; neurons: number; todayGlobalUsedNeurons: number; todayGlobalReservedNeurons: number; todayGlobalLimitNeurons: number };
  const service = data.service as { syncOperations: number; verificationEmailsThisMonth: number; moderationEmailsThisMonth: number; monthlyEmailLimit: number };
  return <>
    <div className="period-toolbar">{["today", "7d", "30d", "90d", "12m"].map((value) => <button key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{periodLabel(value)}</button>)}</div>
    <div className="metric-grid">
      <Metric label="Registered users" value={formatNumber(users.registered)} note={`${formatNumber(users.active)} active`} />
      <Metric label="Successful dictations" value={formatNumber(transcription.succeeded)} note={transcription.successRate === null ? "No requests yet" : `${formatPercent(transcription.successRate)} success`} />
      <Metric label="Voice processed" value={formatDuration(transcription.audioSeconds)} note={`${formatNumber(transcription.quotaRejections)} quota rejections`} />
      <Metric label="Estimated AI cost" value={formatUsd(usage.estimatedCostUsd)} note={`${formatNumber(usage.neurons)} neurons`} />
    </div>
    <div className="dashboard-grid">
      <Panel title="Service activity" kicker="DICTATION"><Summary rows={[["Median processing latency", transcription.medianLatencyMs === null ? "—" : `${formatNumber(transcription.medianLatencyMs)} ms`], ["Failed dictations", formatNumber(transcription.failed)], ["New accounts", formatNumber(users.newInPeriod)], ["Suspended / banned", `${users.suspended} / ${users.banned}`], ["Encrypted sync operations", formatNumber(service.syncOperations)]]} /></Panel>
      <Panel title="Free beta budget" kicker="CAPACITY"><Summary rows={[["Global neurons today", `${formatNumber(usage.todayGlobalUsedNeurons + usage.todayGlobalReservedNeurons)} / ${formatNumber(usage.todayGlobalLimitNeurons)}`], ["Verification emails", formatNumber(service.verificationEmailsThisMonth)], ["Moderation emails", formatNumber(service.moderationEmailsThisMonth)], ["Monthly email budget", `${service.verificationEmailsThisMonth + service.moderationEmailsThisMonth} / ${service.monthlyEmailLimit}`], ["Cost reporting", "Estimated, not an invoice"]]} /></Panel>
    </div>
  </>;
}

function Users({ onOpen, onError }: { onOpen(id: string): void; onError(message: string): void }) {
  const [query, setQuery] = useState(""); const [status, setStatus] = useState("");
  const [users, setUsers] = useState<UserSummary[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (append = false) => {
    setBusy(true);
    const params = new URLSearchParams({ limit: "50" });
    if (query.trim()) params.set("query", query.trim()); if (status) params.set("status", status); if (append && cursor) params.set("cursor", cursor);
    try {
      const value = await adminApi<{ users: UserSummary[]; nextCursor: string | null }>(`/users?${params}`);
      setUsers((current) => append ? [...current, ...value.users] : value.users); setCursor(value.nextCursor);
    } catch (reason) { onError(errorMessage(reason)); } finally { setBusy(false); }
  }, [cursor, onError, query, status]);
  useEffect(() => { void load(false); }, [status]);
  return <Panel>
    <form className="list-toolbar" onSubmit={(event) => { event.preventDefault(); void load(false); }}>
      <input type="search" placeholder="Exact email or user ID" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option></select>
      <button className="primary-button" disabled={busy}>{busy ? "Loading…" : "Search"}</button>
    </form>
    <div className="table-wrap"><table><thead><tr><th>User</th><th>Status</th><th>Last active</th><th>Today</th><th>90-day usage</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.email}</strong><small>{user.id}</small></td><td><StatusPill state={user.status.state} /></td><td>{formatDate(user.lastActivityAt)}</td><td>{formatNumber(user.todayAudioSeconds)} sec<small>of {formatNumber(user.quotaLimitAudioSeconds)} sec</small></td><td>{formatDuration(user.usage90d.audioSeconds)}<small>{formatNumber(user.usage90d.requests)} requests</small></td><td><button className="row-button" onClick={() => onOpen(user.id)}>Open →</button></td></tr>)}</tbody></table></div>
    {!busy && users.length === 0 && <Empty>No accounts match this filter.</Empty>}
    {cursor && <button className="secondary-button load-more" onClick={() => void load(true)}>Load more users</button>}
  </Panel>;
}

function UserDetailView({ userId, onBack, onError }: { userId: string; onBack(): void; onError(message: string): void }) {
  const [user, setUser] = useState<UserDetail | null>(null); const [activity, setActivity] = useState<Activity[]>([]); const [action, setAction] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [detail, events] = await Promise.all([
        adminApi<{ user: UserDetail }>(`/users/${encodeURIComponent(userId)}`),
        adminApi<{ activity: Activity[] }>(`/users/${encodeURIComponent(userId)}/activity?limit=50`),
      ]);
      setUser(detail.user); setActivity(events.activity);
    } catch (reason) { onError(errorMessage(reason)); }
  }, [onError, userId]);
  useEffect(() => { void load(); }, [load]);
  if (!user) return <Empty>Loading account…</Empty>;
  return <>
    <button className="back-button" onClick={onBack}>← Back to users</button>
    <Panel className="detail-head"><div><p className="eyebrow">ACCOUNT</p><h2>{user.email}</h2><StatusPill state={user.status.state} /></div>{user.role !== "admin" && <div className="action-row">
      {user.status.state !== "suspended" && <button className="secondary-button" onClick={() => setAction("suspend")}>Suspend</button>}
      {user.status.state !== "banned" && <button className="danger-button" onClick={() => setAction("ban")}>Ban</button>}
      {user.status.state !== "active" && <button className="primary-button" onClick={() => setAction("restore")}>Restore</button>}
      <button className="secondary-button" onClick={() => setAction("quota")}>Quota grant</button>
      {user.quota.overrideExpiresAt && <button className="secondary-button" onClick={() => setAction("clear-quota")}>Clear grant</button>}
      <button className="secondary-button" onClick={() => setAction("revoke")}>Revoke sessions</button>
    </div>}</Panel>
    <div className="detail-grid">
      <Panel title="Account"><Summary rows={[["Role", user.role], ["Created", formatDate(user.createdAt)], ["Verified", formatDate(user.verifiedAt)], ["Last active", formatDate(user.lastActivityAt)], ["Terms", user.termsVersion], ["Public message", user.status.publicMessage ?? "—"]]} /></Panel>
      <Panel title="90-day usage"><Summary rows={[["Dictation time", formatDuration(user.usage90d.audioSeconds)], ["Requests", formatNumber(user.usage90d.requests)], ["Neurons", formatNumber(user.usage90d.neurons)], ["Today", `${formatNumber(user.quota.todayUsedAudioSeconds)} / ${formatNumber(user.quota.limitAudioSeconds)} sec`], ["Quota expiry", formatDate(user.quota.overrideExpiresAt)]]} /></Panel>
      <Panel title="Encrypted sync metadata"><Summary rows={user.encryptedSyncMetadata.map((item) => [capitalize(item.type), `${formatNumber(item.count)} · ${formatBytes(item.encryptedBytes)}`])} /></Panel>
      <Panel title="Recent activity" className="wide"><Timeline items={activity.map((item) => ({ id: item.id, title: humanize(item.type), detail: activityDetail(item), time: item.createdAt }))} /></Panel>
      <Panel title="Device sessions"><Summary rows={user.sessions.map((item) => [item.deviceName, formatDate(item.lastSeenAt)])} empty="No active Android sessions." /></Panel>
      <Panel title="Account notices"><div className="notice-list">{user.notifications.length === 0 ? <Empty>No moderation notices.</Empty> : user.notifications.map((item) => <div className="notice" key={item.id}><strong>{humanize(item.action)}</strong><small>{item.status} · {formatDate(item.sentAt ?? item.createdAt)}</small>{item.status === "failed" && <button className="text-button" onClick={() => setAction(`retry:${item.id}`)}>Retry</button>}</div>)}</div></Panel>
    </div>
    {action && <ActionDialog action={action} user={user} onClose={() => setAction(null)} onComplete={async () => { setAction(null); await load(); }} />}
  </>;
}

function ActionDialog({ action, user, onClose, onComplete }: { action: string; user: UserDetail; onClose(): void; onComplete(): Promise<void> }) {
  const [reason, setReason] = useState(""); const [publicMessage, setPublicMessage] = useState(""); const [limit, setLimit] = useState(Math.max(600, user.quota.limitAudioSeconds));
  const [expires, setExpires] = useState(toLocalInput(Date.now() + (action === "suspend" ? 86_400_000 : 7 * 86_400_000))); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const title = action === "suspend" ? "Suspend account" : action === "ban" ? "Ban account" : action === "restore" ? "Restore account" : action === "quota" ? "Temporary quota grant" : action === "clear-quota" ? "Clear quota grant" : action === "revoke" ? "Revoke device sessions" : "Retry account notice";
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (action === "suspend") await adminApi(`/users/${encodeURIComponent(user.id)}/status`, { method: "POST", body: { status: "suspended", suspendedUntil: new Date(expires).getTime(), publicMessage, internalReason: reason } });
      else if (action === "ban") await adminApi(`/users/${encodeURIComponent(user.id)}/status`, { method: "POST", body: { status: "banned", publicMessage, internalReason: reason } });
      else if (action === "restore") await adminApi(`/users/${encodeURIComponent(user.id)}/status`, { method: "POST", body: { status: "active", internalReason: reason } });
      else if (action === "quota") await adminApi(`/users/${encodeURIComponent(user.id)}/quota-override`, { method: "PUT", body: { limitAudioSeconds: limit, expiresAt: new Date(expires).getTime(), internalReason: reason } });
      else if (action === "clear-quota") await adminApi(`/users/${encodeURIComponent(user.id)}/quota-override/clear`, { method: "POST", body: { internalReason: reason } });
      else if (action === "revoke") await adminApi(`/users/${encodeURIComponent(user.id)}/sessions/revoke`, { method: "POST", body: { scope: "all", internalReason: reason } });
      else if (action.startsWith("retry:")) await adminApi(`/notifications/${encodeURIComponent(action.slice(6))}/retry`, { method: "POST", body: { internalReason: reason } });
      await onComplete();
    } catch (reasonValue) { setError(errorMessage(reasonValue)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="action-title"><form onSubmit={submit}><div className="modal-head"><div><p className="eyebrow">CONFIRM ADMIN ACTION</p><h2 id="action-title">{title}</h2></div><button type="button" className="icon-button" onClick={onClose}>×</button></div>
    {action === "suspend" && <label>Suspension ends<input type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} required /></label>}
    {(action === "suspend" || action === "ban") && <label>Message shown to user<textarea value={publicMessage} maxLength={240} onChange={(event) => setPublicMessage(event.target.value)} /></label>}
    {action === "quota" && <><label>Daily seconds<input type="number" min={600} max={3600} value={limit} onChange={(event) => setLimit(Number(event.target.value))} required /></label><label>Grant expires<input type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} required /></label></>}
    <label>Internal reason<textarea value={reason} minLength={5} maxLength={500} onChange={(event) => setReason(event.target.value)} required /></label>
    {error && <Banner>{error}</Banner>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className={action === "ban" || action === "revoke" ? "danger-button" : "primary-button"} disabled={busy}>{busy ? "Working…" : title}</button></div>
  </form></section></div>;
}

function Audit({ onError }: { onError(message: string): void }) {
  const [action, setAction] = useState(""); const [events, setEvents] = useState<AuditEvent[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async (append = false) => {
    setBusy(true); const params = new URLSearchParams({ limit: "50" }); if (action) params.set("action", action); if (append && cursor) params.set("cursor", cursor);
    try { const value = await adminApi<{ audit: AuditEvent[]; nextCursor: string | null }>(`/audit?${params}`); setEvents((current) => append ? [...current, ...value.audit] : value.audit); setCursor(value.nextCursor); }
    catch (reason) { onError(errorMessage(reason)); } finally { setBusy(false); }
  }, [action, cursor, onError]);
  useEffect(() => { void load(false); }, [action]);
  return <Panel title="Administrative actions" kicker="ACCOUNTABILITY"><select className="audit-filter" value={action} onChange={(event) => setAction(event.target.value)}><option value="">All actions</option><option value="admin_login">Admin sign-ins</option><option value="admin_logout">Admin sign-outs</option><option value="user_suspended">Suspensions</option><option value="user_banned">Bans</option><option value="user_restored">Restorations</option><option value="sessions_revoked">Session revocations</option><option value="quota_override_set">Quota grants</option><option value="quota_override_cleared">Cleared grants</option></select>
    {events.length ? <Timeline items={events.map((item) => ({ id: item.id, title: humanize(item.action), detail: `${item.internalReason} · Target: ${item.targetUserId ?? "—"} · Request: ${item.requestId}`, time: item.createdAt }))} /> : !busy && <Empty>No administrative actions in this view.</Empty>}
    {cursor && <button className="secondary-button load-more" onClick={() => void load(true)}>Load more events</button>}
  </Panel>;
}

function Brand() { return <a className="brand" href="/admin/" aria-label="WoVoice admin home"><span className="mark" /><span>WoVoice</span></a>; }
function NavButton({ active, icon, children, onClick }: { active: boolean; icon: string; children: ReactNode; onClick(): void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span>{icon}</span>{children}</button>; }
function Panel({ title, kicker, children, className = "" }: { title?: string; kicker?: string; children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{title && <div className="panel-heading"><div>{kicker && <p className="eyebrow">{kicker}</p>}<h2>{title}</h2></div></div>}{children}</section>; }
function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <article className="metric"><p>{label}</p><strong>{value}</strong><small>{note}</small></article>; }
function Summary({ rows, empty }: { rows: Array<[string, string]>; empty?: string }) { return rows.length ? <div className="summary-list">{rows.map(([label, value]) => <div className="summary-row" key={`${label}-${value}`}><span>{label}</span><strong>{value}</strong></div>)}</div> : <Empty>{empty ?? "No data yet."}</Empty>; }
function Timeline({ items }: { items: Array<{ id: string; title: string; detail: string; time: number }> }) { return <div className="timeline">{items.map((item) => <article className="timeline-item" key={item.id}><span className="timeline-dot" /><div><h3>{item.title}</h3><p>{item.detail}</p></div><time>{formatDate(item.time)}</time></article>)}</div>; }
function StatusPill({ state }: { state: AccountState }) { return <span className={`status-pill ${state}`}>{state}</span>; }
function Banner({ children }: { children: ReactNode }) { return <div className="banner error" role="alert">{children}</div>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
function FullPageStatus({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) { return <main className="login-page"><section className="login-card"><Brand /><h1>{title}</h1><p className="muted">{detail}</p>{action}</section></main>; }
function LoadingCards() { return <div className="metric-grid">{Array.from({ length: 4 }, (_, index) => <div className="metric skeleton" key={index} />)}</div>; }

function currentRoute(): { view: View; userId: string | null } {
  const detail = location.pathname.match(/^\/admin\/users\/([^/]+)$/u);
  if (detail) return { view: "detail", userId: decodeURIComponent(detail[1]) };
  if (location.pathname.startsWith("/admin/users")) return { view: "users", userId: null };
  if (location.pathname.startsWith("/admin/audit")) return { view: "audit", userId: null };
  return { view: "overview", userId: null };
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : "Something went wrong. Try again."; }
function periodLabel(value: string): string { return value === "today" ? "Today" : value === "12m" ? "12 months" : value.replace("d", " days"); }
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value) || 0); }
function formatPercent(value: number): string { return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value); }
function formatUsd(value: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(Number(value) || 0); }
function formatDuration(seconds: number): string { const value = Math.max(0, Number(seconds) || 0); if (value < 60) return `${Math.round(value)} sec`; const hours = Math.floor(value / 3600); const minutes = Math.round((value % 3600) / 60); return hours ? `${hours}h ${minutes}m` : `${minutes} min`; }
function formatDate(value: number | null): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function formatBytes(value: number): string { return new Intl.NumberFormat(undefined, { style: "unit", unit: "byte", notation: "compact", unitDisplay: "narrow" }).format(Number(value) || 0); }
function humanize(value: string): string { return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase()); }
function capitalize(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
function toLocalInput(value: number): string { return new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function activityDetail(item: Activity): string { const values = [item.outcomeCode, item.audioSeconds === null ? null : formatDuration(item.audioSeconds), item.model, item.latencyMs === null ? null : `${formatNumber(item.latencyMs)} ms`, item.itemCount === null ? null : `${item.itemCount} items`, item.deviceName].filter(Boolean); return values.join(" · ") || "Operational event"; }
