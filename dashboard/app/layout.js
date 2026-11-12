import './globals.css';

export const metadata = { title: 'Hollywood Clinic — Ads & Leads', robots: { index: false, follow: false } };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
