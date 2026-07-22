'use client';

import dynamic from 'next/dynamic';
import Loading from '@/components/Loading';

// The whole experience is client-only (WebGL + Rapier WASM). Never SSR it.
const App = dynamic(() => import('@/components/App'), {
  ssr: false,
  loading: () => <Loading progress={0.05} label="불러오는 중…" />,
});

export default function Page() {
  return <App />;
}
