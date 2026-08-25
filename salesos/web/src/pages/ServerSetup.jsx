import { useEffect, useState } from 'react';
import { normaliseServerOrigin, probeServer, setServerOrigin } from '../lib/server.js';
import { TextField, Spinner } from '../components/UI.jsx';

/**
 * First launch of the installed app.
 *
 * A browser build is served by the API and needs none of this. An installed app
 * is a bundle on a phone with no idea which SalesOS it belongs to, so it has to
 * ask once. The address is probed against /health before it is saved: a typo here
 * would otherwise surface as every screen failing at once, with nothing pointing
 * back at the cause.
 */
export default function ServerSetup({ onConnected }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = 'Connect to your server - SalesOS';
  }, []);

  const submit = async (event) => {
    event?.preventDefault();
    setError(null);

    let origin;
    try {
      origin = normaliseServerOrigin(value);
    } catch (problem) {
      setError(problem.message);
      return;
    }

    setBusy(true);
    const result = await probeServer(origin);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setServerOrigin(origin);
    onConnected?.(origin);
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
            <h1 style={{ fontSize: 'var(--text-xl)' }}>Connect to your server</h1>
            <p className="secondary small">
              SalesOS runs on your own server. Enter its address once and this app
              will remember it.
            </p>
          </div>

          <form className="col" onSubmit={submit}>
            <TextField
              label="Server address"
              hint="Include the port, for example 192.168.1.20:4000"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              placeholder="192.168.1.20:4000"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              required
            />
            {error && <div className="banner danger small">{error}</div>}
            <button type="submit" className="btn primary lg block" disabled={busy}>
              {busy ? <Spinner /> : null}
              {busy ? 'Checking' : 'Connect'}
            </button>
          </form>

          <span className="xs muted">
            Your phone and the server need to be on the same network, unless the
            server is reachable over the internet.
          </span>
        </div>
      </div>
    </div>
  );
}
