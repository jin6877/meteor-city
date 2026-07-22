import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '운석 도시 — Meteor City',
  description:
    '매번 새로 지어지는 미니어처 3D 도시에 운석을 떨어뜨리고, 건물이 물리로 부서지는 순간을 슬로모로 감상하세요. 시드 링크로 같은 도시를 친구에게 던져보세요.',
  openGraph: {
    title: '운석 도시 — Meteor City',
    description: '틸트시프트 미니어처 도시를 운석으로 톡 — 그 순간 번쩍. 이 도시 부숴봐.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#1C1F26',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        {/* Pretendard (DESIGN §6) — CDN, system fallback lives in globals.css */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css"
        />
      </head>
      <body>
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
