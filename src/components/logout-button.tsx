'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  const handleLogout = async () => {
    try {
      await fetch('/api/public/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout request failed:', error);
    }
    const ssoLoginUrl = process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';
    window.location.href = `${ssoLoginUrl}/dashboard`;
  };

  return (
    <Button variant="outline" size="sm" onClick={handleLogout}>
      <LogOut className="h-4 w-4" />
      Logout
    </Button>
  );
}
