'use client';

/**
 * Themed loader (DESIGN §6 마이크로카피). Shown while Rapier WASM + fracture
 * cache + first city build run. Dark, calm, with a falling-meteor motif.
 */
export default function Loading({
  progress,
  label,
}: {
  progress: number;
  label: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0b0d10] text-[#f2eee6]">
      <div className="relative mb-7 h-16 w-16">
        <div className="absolute inset-0 rounded-full bg-[#f26a2e]/15 blur-xl" />
        <svg viewBox="0 0 64 64" className="relative h-16 w-16">
          <defs>
            <radialGradient id="mglow" cx="50%" cy="42%" r="60%">
              <stop offset="0%" stopColor="#ffd7a0" />
              <stop offset="55%" stopColor="#f26a2e" />
              <stop offset="100%" stopColor="#7a2a12" />
            </radialGradient>
          </defs>
          <g className="origin-center animate-[spin_5s_linear_infinite]">
            <circle cx="32" cy="30" r="14" fill="url(#mglow)" />
            <circle cx="27" cy="26" r="3" fill="#0b0d10" opacity="0.28" />
            <circle cx="37" cy="33" r="2.2" fill="#0b0d10" opacity="0.22" />
            <circle cx="33" cy="24" r="1.6" fill="#0b0d10" opacity="0.2" />
          </g>
        </svg>
      </div>
      <p className="mb-4 text-sm font-medium tracking-tight text-[#f2eee6]">{label}</p>
      <div className="h-1 w-52 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[#f26a2e] transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-xs text-[#a7a399]">{pct}%</p>
    </div>
  );
}
