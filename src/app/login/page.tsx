'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState('Checking authentication...');

  useEffect(() => {
    const returnTo = searchParams.get('returnTo');
    if (returnTo) {
      sessionStorage.setItem('mw_returnTo', returnTo);
    }
  }, [searchParams]);

  useEffect(() => {
    checkAuthAndRedirect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAuthAndRedirect() {
    try {
      setMessage('Checking authentication...');
      const response = await fetch('/api/auth/check', { credentials: 'include' });

      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) {
          const returnTo = sessionStorage.getItem('mw_returnTo') || '/';
          sessionStorage.removeItem('mw_returnTo');
          router.push(returnTo);
          return;
        }
      }

      const ssoLoginUrl = process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';
      setMessage('Redirecting to Trames SSO login...');
      setTimeout(() => {
        window.location.href = `${ssoLoginUrl}/dashboard`;
      }, 800);
    } catch (error) {
      console.error('[Login] Auth check failed:', error);
      setMessage('Authentication check failed. Redirecting to SSO...');
      const ssoLoginUrl = process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';
      setTimeout(() => {
        window.location.href = `${ssoLoginUrl}/dashboard`;
      }, 800);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="w-full max-w-md rounded-xl border bg-white shadow p-6">
        <div className="flex flex-col space-y-1.5 pb-4">
          <h2 className="text-2xl font-semibold">Meeting Whisperer</h2>
          <p className="text-sm text-gray-500">{message}</p>
        </div>
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
        <p className="text-center text-sm text-gray-600">Redirecting to login.trames.io</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginInner />
    </Suspense>
  );
}
