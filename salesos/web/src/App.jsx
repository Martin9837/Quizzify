import { Navigate, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { needsServerConfig } from './lib/server.js';
import { RealtimeProvider } from './lib/realtime.jsx';
import { ToastProvider, Spinner } from './components/UI.jsx';
import AppShell from './components/AppShell.jsx';

import Login from './pages/Login.jsx';
import ServerSetup from './pages/ServerSetup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Leads from './pages/Leads.jsx';
import LeadDetail from './pages/LeadDetail.jsx';
import Companies from './pages/Companies.jsx';
import Pipeline from './pages/Pipeline.jsx';
import Calls from './pages/Calls.jsx';
import Conversations from './pages/Conversations.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import Inbox from './pages/Inbox.jsx';
import Tasks from './pages/Tasks.jsx';
import Calendar from './pages/Calendar.jsx';
import Activity from './pages/Activity.jsx';
import Insights from './pages/Insights.jsx';
import Approvals from './pages/Approvals.jsx';
import Analytics from './pages/Analytics.jsx';
import Team from './pages/Team.jsx';
import Coaching from './pages/Coaching.jsx';
import Admin from './pages/Admin.jsx';
import NotFound from './pages/NotFound.jsx';

/** Blocks a route until the session is known, then guards by permission. */
function Protected({ children, permission }) {
  const { status, can } = useAuth();
  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spinner large label="Loading your workspace" />
      </div>
    );
  }
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (permission && !can(permission)) {
    return (
      <div className="page">
        <div className="banner danger">
          <div>
            <strong>You do not have permission to view this area.</strong>
            <div className="small">
              Your role does not include <span className="mono">{permission}</span>. Ask an administrator
              if you believe this is wrong.
            </div>
          </div>
        </div>
      </div>
    );
  }
  return children;
}

export default function App() {
  // The installed app has to know which server it talks to before any provider
  // can usefully mount -- AuthProvider's first act is a call to that server. In
  // a browser needsServerConfig() is always false and this collapses away.
  const [unconfigured, setUnconfigured] = useState(needsServerConfig);
  if (unconfigured) {
    return (
      <ToastProvider>
        <ServerSetup onConnected={() => setUnconfigured(false)} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <AuthProvider>
        <RealtimeProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<Protected><AppShell /></Protected>}>
              <Route index element={<Dashboard />} />
              <Route path="leads" element={<Leads />} />
              <Route path="leads/:leadId" element={<LeadDetail />} />
              <Route path="companies" element={<Companies />} />
              <Route path="companies/:companyId" element={<Companies />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="calls" element={<Calls />} />
              <Route path="conversations" element={<Conversations />} />
              <Route path="conversations/:callId" element={<ConversationDetail />} />
              <Route path="inbox" element={<Inbox />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="calendar" element={<Calendar />} />
              <Route path="activity" element={<Activity />} />
              <Route path="insights" element={<Insights />} />
              <Route path="approvals" element={<Approvals />} />
              <Route path="analytics" element={<Analytics />} />
              {/* Manager and admin areas are guarded at the route, not just hidden
                  in the navigation: a direct URL must give a clean refusal
                  rather than a page that renders and then fails every call. */}
              <Route path="team" element={<Protected permission="analytics:team"><Team /></Protected>} />
              <Route path="coaching" element={<Protected permission="coaching:read"><Coaching /></Protected>} />
              <Route path="admin/*" element={<Protected permission="user:read"><Admin /></Protected>} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </RealtimeProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
