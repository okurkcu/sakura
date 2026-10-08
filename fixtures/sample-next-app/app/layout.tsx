import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'Sample shop',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav>
            <a href="/">Home</a> · <a href="/orders">Orders</a> · <a href="/dashboard">Dashboard</a>{' '}
            · <a href="/login">Log in</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
