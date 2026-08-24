import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api, { clearTokens, hasSession, onAuthLost } from './api.js';

/**
 * Session context. Holds the signed-in user, their organisation settings and
 * the permission list the server computed for their role -- the UI never infers
 * permissions from the role name, it uses what the server granted.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: hasSession() ? 'loading' : 'anonymous', user: null, organization: null, team: null });

  const load = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setState({ status: 'authenticated', user: data.user, organization: data.organization, team: data.team });
      return data;
    } catch {
      clearTokens();
      setState({ status: 'anonymous', user: null, organization: null, team: null });
      return null;
    }
  }, []);

  useEffect(() => {
    if (hasSession()) load();
  }, [load]);

  useEffect(() => onAuthLost(() => {
    setState({ status: 'anonymous', user: null, organization: null, team: null });
  }), []);

  const login = useCallback(async (credentials) => {
    const data = await api.login(credentials);
    setState({ status: 'authenticated', user: data.user, organization: data.organization, team: null });
    return data;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setState({ status: 'anonymous', user: null, organization: null, team: null });
  }, []);

  const value = useMemo(() => ({
    ...state,
    login,
    logout,
    refresh: load,
    can: (permission) => Boolean(state.user?.permissions?.includes(permission)),
    isManager: ['manager', 'admin', 'super_admin'].includes(state.user?.role),
    isAdmin: ['admin', 'super_admin'].includes(state.user?.role),
    settings: state.organization?.settings || {},
    updateSettings: (settings) => setState((prev) => ({
      ...prev,
      organization: prev.organization ? { ...prev.organization, settings } : prev.organization,
    })),
  }), [state, login, logout, load]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
