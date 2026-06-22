import { useEffect, useState } from 'react';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { Hub as AmplifyHub } from 'aws-amplify/utils';
import ActivityHub from './hub/Hub';

interface AppProps {
  isMock: boolean;
}

export default function App({ isMock }: AppProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(isMock ? true : null);
  const [userEmail, setUserEmail] = useState<string>('');

  useEffect(() => {
    if (isMock) {
      setUserEmail('dev@mock.local');
      return;
    }

    const checkAuth = async () => {
      try {
        const user = await getCurrentUser();
        setUserEmail(user.signInDetails?.loginId ?? user.username);
        setAuthenticated(true);
      } catch {
        setAuthenticated(false);
      }
    };

    checkAuth();

    const listener = AmplifyHub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn') {
        getCurrentUser().then(u => {
          setUserEmail(u.signInDetails?.loginId ?? u.username);
          setAuthenticated(true);
        });
      } else if (payload.event === 'signedOut') {
        setAuthenticated(false);
      }
    });

    return () => listener();
  }, [isMock]);

  const handleSignOut = async () => {
    if (isMock) return;
    await signOut();
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
    const hasCode = new URLSearchParams(window.location.search).has('code');
    if (!hasCode) {
      signInWithRedirect();
    }
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
