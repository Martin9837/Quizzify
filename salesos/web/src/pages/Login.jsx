import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { TextField, Spinner } from '../components/UI.jsx';
import { IconSparkles, IconWave, IconRobot, IconShield, IconChevronRight } from '../components/Icons.jsx';

const DEMO_ACCOUNTS = [
  { email: 'agent@northstar.demo', role: 'Sales Agent', description: 'Own book of business, calling, AI approvals' },
  { email: 'manager@northstar.demo', role: 'Sales Manager', description: 'Team performance, coaching, call reviews' },
  { email: 'admin@northstar.demo', role: 'Admin', description: 'Users, fields, integrations, audit logs' },
  { email: 'owner@northstar.demo', role: 'Super Admin', description: 'Billing, retention, full automation policy' },
];

const FEATURES = [
  { icon: <IconWave size={16} />, title: 'Every call becomes CRM data', body: 'Recording to transcript to structured fields, automatically.' },
  { icon: <IconRobot size={16} />, title: 'AI suggests, humans decide', body: 'Sensitive changes always land in an approval queue with the evidence.' },
  { icon: <IconSparkles size={16} />, title: 'Ask your pipeline anything', body: '"Who should I call today?" answered from your own records.' },
  { icon: <IconShield size={16} />, title: 'Consent and audit built in', body: 'Region-aware recording rules and a full change history.' },
];

export default function Login() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('agent@northstar.demo');
  const [password, setPassword] = useState('Demo1234!');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = 'Sign in - SalesOS';
  }, []);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const submit = async (event) => {
    event?.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login({ email: email.trim(), password });
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught.message || 'Sign in failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="auth-card">
          <div className="row-tight">
            <span className="brand-mark" style={{ width: 32, height: 32, fontSize: 15 }}>S</span>
            <div className="col-tight" style={{ gap: 0 }}>
              <strong style={{ fontSize: 'var(--text-lg)' }}>SalesOS</strong>
              <span className="xs muted">AI sales operating system</span>
            </div>
          </div>

          <div className="col-tight">
            <h1 style={{ fontSize: 'var(--text-xl)' }}>Sign in</h1>
            <p className="secondary small">Use a demo account below, or your own credentials.</p>
          </div>

          <form className="col" onSubmit={submit}>
            <TextField
              label="Work email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            {error && <div className="banner danger small">{error}</div>}
            <button type="submit" className="btn primary lg block" disabled={pending}>
              {pending ? <Spinner /> : null}
              Sign in
            </button>
          </form>

          <div className="col-tight">
            <span className="uppercase muted">Demo accounts</span>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="demo-account"
                onClick={() => {
                  setEmail(account.email);
                  setPassword('Demo1234!');
                }}
              >
                <span className="col-tight" style={{ gap: 0 }}>
                  <span className="small strong">{account.role}</span>
                  <span className="xs muted">{account.description}</span>
                </span>
                <IconChevronRight />
              </button>
            ))}
            <span className="xs muted">All demo accounts use the password <span className="mono">Demo1234!</span></span>
          </div>
        </div>
      </div>

      <aside className="auth-aside">
        <div className="col">
          <h2>Every customer conversation becomes structured sales intelligence.</h2>
          <p style={{ opacity: 0.75, maxWidth: '46ch' }}>
            Call from one screen. The transcript, the summary, the objections, the next step and the CRM
            updates are waiting for you when you hang up.
          </p>
        </div>
        <div className="col gap-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="feature">
              <span className="feature-icon">{feature.icon}</span>
              <div className="col-tight" style={{ gap: 2 }}>
                <strong className="small">{feature.title}</strong>
                <span className="small" style={{ opacity: 0.7 }}>{feature.body}</span>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
