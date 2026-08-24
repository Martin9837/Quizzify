import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useRealtime, useRealtimeEvent } from '../lib/realtime.jsx';
import { useApi, useKeyboardShortcut, useLocalState, useIsMobile } from '../lib/hooks.js';
import api from '../lib/api.js';
import { Avatar, Badge, Drawer, useToast } from './UI.jsx';
import CommandPalette from './CommandPalette.jsx';
import AIAssistant from './AIAssistant.jsx';
import CallDock from './CallDock.jsx';
import { relative, titleCase } from '../lib/format.js';
import {
  IconDashboard, IconUsers, IconPhone, IconSparkles, IconPipeline, IconTask,
  IconCalendar, IconChart, IconSettings, IconBell, IconSearch, IconMoon, IconSun,
  IconLogout, IconMenu, IconInbox, IconBookOpen, IconTarget, IconChevronLeft,
  IconChevronRight, IconBuilding, IconWave, IconRobot,
} from './Icons.jsx';

/**
 * Application shell: navigation, global search, notifications, theme, the
 * persistent AI assistant, and the call dock that follows the agent around the
 * app so a live call is never interrupted by navigation.
 */

const NAV = [
  { section: 'Sell' },
  { to: '/', label: 'Dashboard', icon: <IconDashboard />, end: true },
  { to: '/leads', label: 'Leads', icon: <IconUsers /> },
  { to: '/companies', label: 'Companies', icon: <IconBuilding /> },
  { to: '/pipeline', label: 'Pipeline', icon: <IconPipeline /> },
  { to: '/calls', label: 'Calls', icon: <IconPhone /> },
  { to: '/conversations', label: 'Conversations', icon: <IconWave /> },
  { to: '/inbox', label: 'Email', icon: <IconInbox /> },
  { to: '/tasks', label: 'Tasks', icon: <IconTask />, countKey: 'tasks' },
  { to: '/calendar', label: 'Calendar', icon: <IconCalendar /> },
  { to: '/activity', label: 'Activity', icon: <IconWave /> },
  { section: 'Intelligence' },
  { to: '/insights', label: 'AI insights', icon: <IconSparkles /> },
  { to: '/approvals', label: 'AI approvals', icon: <IconRobot />, countKey: 'approvals' },
  { to: '/analytics', label: 'Analytics', icon: <IconChart /> },
  { section: 'Manage', permission: 'analytics:team' },
  { to: '/team', label: 'Team', icon: <IconTarget />, permission: 'analytics:team' },
  { to: '/coaching', label: 'Coaching', icon: <IconBookOpen />, permission: 'coaching:read' },
  { section: 'Administer', permission: 'user:write' },
  { to: '/admin', label: 'Admin', icon: <IconSettings />, permission: 'user:write' },
];

function ThemeToggle({ theme, onChange }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn ghost icon"
      onClick={() => onChange(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

function NotificationBell() {
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data, refetch, setData } = useApi('/notifications', { limit: 30 });

  useRealtimeEvent('notification.created', () => refetch());
  useRealtimeEvent('notification.read', () => refetch());

  const unread = data?.unread || 0;

  const markAll = async () => {
    await api.post('/notifications/read', { all: true });
    setData((current) => ({
      ...current,
      unread: 0,
      notifications: (current?.notifications || []).map((n) => ({ ...n, read_at: new Date().toISOString() })),
    }));
  };

  const openNotification = async (notification) => {
    if (!notification.read_at) await api.post('/notifications/read', { ids: [notification.id] });
    setOpen(false);
    refetch();
    if (notification.link) navigate(notification.link);
  };

  return (
    <>
      <button
        type="button"
        className="btn ghost icon"
        onClick={() => setOpen(true)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        style={{ position: 'relative' }}
      >
        <IconBell />
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute', top: 4, right: 4, minWidth: 15, height: 15, borderRadius: 8,
              background: 'var(--danger)', color: '#fff', fontSize: 9, fontWeight: 700,
              display: 'grid', placeItems: 'center', padding: '0 3px',
            }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        actions={unread > 0 && <button type="button" className="btn sm ghost" onClick={markAll}>Mark all read</button>}
      >
        {!data?.notifications?.length && <div className="empty small">Nothing new. You are all caught up.</div>}
        <div className="col-tight">
          {(data?.notifications || []).map((notification) => (
            <button
              key={notification.id}
              type="button"
              className="card hover"
              style={{
                textAlign: 'left', padding: 'var(--space-3)', gap: 'var(--space-1)',
                borderColor: notification.read_at ? 'var(--surface-border)' : 'var(--accent-border)',
                background: notification.read_at ? 'var(--bg-raised)' : 'var(--accent-soft)',
              }}
              onClick={() => openNotification(notification)}
            >
              <div className="between">
                <Badge tone={notification.priority === 'high' ? 'danger' : 'outline'}>
                  {titleCase(notification.type)}
                </Badge>
                <span className="xs muted">{relative(notification.created_at)}</span>
              </div>
              <strong className="small">{notification.title}</strong>
              {notification.body && <span className="xs secondary">{notification.body}</span>}
            </button>
          ))}
        </div>
      </Drawer>
    </>
  );
}

export default function AppShell() {
  const { user, organization, logout, can, isManager } = useAuth();
  const { connected } = useRealtime();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const isMobile = useIsMobile();

  const [theme, setTheme] = useLocalState('salesos.theme', 'system');
  const [collapsed, setCollapsed] = useLocalState('salesos.sidebar.collapsed', false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState(null);
  const [activeCall, setActiveCall] = useState(null);

  // Apply the theme to the document root; 'system' removes the attribute so the
  // prefers-color-scheme media query takes over.
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useKeyboardShortcut('mod+k', () => setPaletteOpen(true));
  useKeyboardShortcut('mod+j', () => setAssistantOpen((value) => !value));
  useKeyboardShortcut('/', () => setPaletteOpen(true));

  const counts = useApi('/tasks', { limit: 1, today: 'true' });
  const approvals = useApi('/ai/suggestions', { status: 'pending', limit: 1 });

  // Restore an in-progress call after a page reload.
  const { data: active } = useApi('/calls/active');
  useEffect(() => {
    if (active?.calls?.length && !activeCall) {
      const call = active.calls[0];
      api.get(`/calls/${call.id}`).then((detail) => {
        setActiveCall({ call: detail.call, context: detail.context, lead: null, consent: null });
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useRealtimeEvent('call.incoming', (payload) => {
    toast.info(`Incoming call from ${payload.lead?.name || payload.maskedNumber || 'unknown number'}`);
    setActiveCall((current) => current || { call: payload, context: null, lead: payload.lead, consent: null });
  });

  useRealtimeEvent('analysis.ready', (payload) => {
    toast.success(payload.pending
      ? `AI found ${payload.pending} CRM update${payload.pending === 1 ? '' : 's'} to review`
      : 'Call analysis ready');
  });

  const startCall = useCallback(async ({ leadId, toNumber, dealId }) => {
    try {
      const result = await api.post('/calls', { leadId, toNumber, dealId });
      setActiveCall({ call: result.call, context: result.context, lead: result.lead, consent: result.consent });
      return result;
    } catch (error) {
      toast.error(error);
      return null;
    }
  }, [toast]);

  // Exposed so any page can dial without prop-drilling through the router.
  useEffect(() => {
    window.salesos = { startCall, askAi: (question) => { setAssistantQuestion(question); setAssistantOpen(true); } };
    return () => {
      delete window.salesos;
    };
  }, [startCall]);

  const navItems = useMemo(() => NAV.filter((item) => !item.permission || can(item.permission)), [can]);
  const countFor = (key) => (key === 'tasks' ? counts.data?.counts?.today : key === 'approvals' ? approvals.data?.total : undefined);

  return (
    <div className="shell" data-collapsed={!isMobile && collapsed}>
      <a href="#main-content" className="skip-link">Skip to content</a>

      <aside className="sidebar" data-open={mobileNavOpen}>
        <Link to="/" className="sidebar-brand">
          <span className="brand-mark">S</span>
          <span className="brand-text col-tight" style={{ gap: 0 }}>
            <span>SalesOS</span>
            <span className="xs muted" style={{ fontWeight: 500 }}>{organization?.name}</span>
          </span>
        </Link>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item, index) => {
            if (item.section) {
              return <div key={`section-${index}`} className="sidebar-section uppercase">{item.section}</div>;
            }
            const count = countFor(item.countKey);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                {count ? <span className="nav-count">{count}</span> : null}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer col-tight">
          <div className="row-tight">
            <Avatar name={user?.name} color={user?.avatarColor} />
            <div className="grow col-tight nav-label" style={{ gap: 0, minWidth: 0 }}>
              <span className="small strong truncate">{user?.name}</span>
              <span className="xs muted truncate">{user?.roleLabel}</span>
            </div>
          </div>
          <div className="row-tight nav-label">
            <span className="xs muted row-tight" title={connected ? 'Live updates connected' : 'Reconnecting'}>
              <span
                style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: connected ? 'var(--success)' : 'var(--warning)',
                }}
              />
              {connected ? 'Live' : 'Offline'}
            </span>
            <button
              type="button"
              className="btn ghost icon sm right"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
            </button>
            <button type="button" className="btn ghost icon sm" onClick={logout} aria-label="Sign out" title="Sign out">
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      {mobileNavOpen && <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          {isMobile && (
            <button type="button" className="btn ghost icon" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <IconMenu />
            </button>
          )}

          <button
            type="button"
            className="btn subtle grow"
            style={{ justifyContent: 'flex-start', maxWidth: 460, color: 'var(--text-muted)' }}
            onClick={() => setPaletteOpen(true)}
          >
            <IconSearch />
            <span className="truncate">Search or ask anything</span>
            <span className="right row-tight"><kbd>⌘</kbd><kbd>K</kbd></span>
          </button>

          <div className="right row-tight">
            <button
              type="button"
              className="btn subtle"
              onClick={() => { setAssistantQuestion(null); setAssistantOpen(true); }}
              title="AI assistant (⌘J)"
            >
              <IconSparkles />
              <span className="nav-label">Ask AI</span>
            </button>
            <NotificationBell />
            <ThemeToggle theme={theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme} onChange={setTheme} />
          </div>
        </header>

        <main id="main-content" className="page">
          <Outlet context={{ startCall, askAi: (question) => { setAssistantQuestion(question); setAssistantOpen(true); }, isManager }} />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAskAi={(question) => { setAssistantQuestion(question); setAssistantOpen(true); }}
      />

      <AIAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        initialQuestion={assistantQuestion}
      />

      {activeCall && (
        <CallDock
          call={activeCall.call}
          context={activeCall.context}
          lead={activeCall.lead}
          consent={activeCall.consent}
          onUpdate={(call) => setActiveCall((current) => (current ? { ...current, call: { ...current.call, ...call } } : current))}
          onEnded={() => setTimeout(() => setActiveCall(null), 2600)}
        />
      )}

      {!activeCall && !assistantOpen && (
        <button
          type="button"
          className="assistant-fab"
          onClick={() => { setAssistantQuestion(null); setAssistantOpen(true); }}
          aria-label="Open AI assistant"
          title="AI assistant (⌘J)"
        >
          <IconSparkles size={20} />
        </button>
      )}
    </div>
  );
}
