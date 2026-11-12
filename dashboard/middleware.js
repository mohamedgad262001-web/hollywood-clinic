import { NextResponse } from 'next/server';

// Simple password protection: the dashboard shows patient names and phones.
export function middleware(req) {
  const user = process.env.DASHBOARD_USER || 'hollywood';
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return new NextResponse('Set DASHBOARD_PASSWORD in the environment.', { status: 500 });

  const header = req.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const [u, ...rest] = atob(header.slice(6)).split(':');
    if (u === user && rest.join(':') === pass) return NextResponse.next();
  }
  return new NextResponse('Login required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Hollywood dashboard", charset="UTF-8"' }
  });
}

// /api/track is public: the website's tracking script posts visits and phone-number leads to it.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/track).*)'] };
