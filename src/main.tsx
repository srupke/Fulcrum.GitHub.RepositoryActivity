import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import App from './App';
import './index.css';

const isMock = import.meta.env.VITE_MOCK === 'true' || !import.meta.env.VITE_USER_POOL_ID;

if (!isMock) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
        loginWith: {
          oauth: {
            domain: import.meta.env.VITE_COGNITO_DOMAIN,
            scopes: ['openid', 'email', 'profile'],
            redirectSignIn: [window.location.origin + '/'],
            redirectSignOut: [window.location.origin + '/'],
            responseType: 'code',
          },
        },
      },
    },
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App isMock={isMock} />
  </React.StrictMode>
);
