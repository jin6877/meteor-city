'use client';

/**
 * Friendly fallback for browsers without WebGL / WASM, or a hard init failure
 * (DESIGN §6 / PROJECT.md §9). No dead end — explains and points to desktop.
 */
export default function ErrorFallback({ detail }: { detail?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[#0b0d10] px-6 text-center text-[#f2eee6]">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[#1c1f26] shadow-lg">
        <svg viewBox="0 0 48 48" className="h-11 w-11">
          <circle cx="24" cy="22" r="12" fill="#f26a2e" opacity="0.9" />
          <path d="M14 34 L34 34 L30 40 L18 40 Z" fill="#3a332c" />
        </svg>
      </div>
      <h1 className="text-lg font-semibold tracking-tight">
        이 브라우저에선 3D 파괴를 못 돌려요
      </h1>
      <p className="max-w-sm text-sm leading-relaxed text-[#a7a399]">
        WebGL / WebAssembly 가 필요해요. 데스크탑 크롬이나 엣지에서 열어보세요.
      </p>
      {detail ? (
        <p className="max-w-sm text-xs text-[#6d6a62]">{detail}</p>
      ) : null}
    </div>
  );
}
