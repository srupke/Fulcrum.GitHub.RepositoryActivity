import { useEffect, useState } from 'react';
import { getCurrentUser, fetchAuthSession, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { Hub as AmplifyHub } from 'aws-amplify/utils';
import ActivityHub from './hub/Hub';

interface AppProps {
  isMock: boolean;
}

export default function App({ isMock }: AppProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(isMock ? true : null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (isMock) {
      setUserEmail('dev@mock.local');
      return;
    }

    const checkAuth = async () => {
      let user;
      try {
        user = await getCurrentUser();
      } catch {
        setAuthenticated(false);
        return;
      }
      setAuthenticated(true);
      try {
        const session = await fetchAuthSession();
        const email = session.tokens?.idToken?.payload?.email as string | undefined;
        setUserEmail(email ?? user.signInDetails?.loginId ?? user.username);
      } catch {
        setUserEmail(user.signInDetails?.loginId ?? user.username);
      }
    };

    checkAuth();

    const listener = AmplifyHub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn') {
        getCurrentUser().then(async u => {
          setAuthenticated(true);
          try {
            const session = await fetchAuthSession();
            const email = session.tokens?.idToken?.payload?.email as string | undefined;
            setUserEmail(email ?? u.signInDetails?.loginId ?? u.username);
          } catch {
            setUserEmail(u.signInDetails?.loginId ?? u.username);
          }
        });
      } else if (payload.event === 'signedOut') {
        setAuthenticated(false);
      }
    });

    return () => listener();
  }, [isMock]);

  const handleSignOut = async () => {
    if (isMock) return;
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // signOut threw before it could redirect — clear storage and reload
      localStorage.clear();
      sessionStorage.clear();
      window.location.replace('/');
    }
  };

  if (authenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading…</span>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    // Don't call signInWithRedirect while the signOut redirect is still in
    // flight — Amplify fires signedOut synchronously before it navigates to
    // the Cognito logout endpoint, so without this guard the sign-in redirect
    // would race against and overwrite the logout redirect.
    const hasCode = new URLSearchParams(window.location.search).has('code');
    if (!hasCode && !signingOut) signInWithRedirect();
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-gray-500">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Redirecting to login…</span>
        </div>
      </div>
    );
  }

  return <ActivityHub isMock={isMock} userEmail={userEmail} onSignOut={handleSignOut} />;
}
