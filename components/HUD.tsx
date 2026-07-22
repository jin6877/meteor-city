'use client';

/**
 * Minimal DOM chrome (DESIGN §6): near-opaque dark chips, hairline borders, one
 * soft shadow, ember accent for active state. Sits at the bottom so the 3/4
 * beauty band stays clear; auto-dims when idle for clean capture. Custom meteor
 * silhouettes — no emoji.
 */
import { METEOR_TYPES, METEOR_SIZES, type MeteorType, type MeteorSize } from '@/lib/share';
import { METEOR_PRESETS } from '@/lib/meteorPresets';

function RockyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M6 10c-1-3 2-6 5-6s7 1 7 5c1 2-1 5-3 6-1 3-6 4-8 1-2-2-2-4-1-6z" />
    </svg>
  );
}
function IronIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M12 3l6 4-1 7-5 4-6-4-1-7z" />
      <path d="M12 3l6 4-6 3-6-4z" fill="#ffffff" opacity="0.28" />
    </svg>
  );
}
function JaggedIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M12 2l3 5 5-2-2 5 4 3-5 2 1 5-6-3-5 3 1-5-4-3 5-2-2-5 5 2z" />
    </svg>
  );
}
function CometIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M3 21l9-7" stroke="currentColor" strokeWidth="1.6" opacity="0.5" fill="none" />
      <circle cx="16" cy="9" r="5" />
    </svg>
  );
}
const ICONS: Record<MeteorType, () => React.JSX.Element> = {
  rocky: RockyIcon,
  iron: IronIcon,
  jagged: JaggedIcon,
  comet: CometIcon,
};

function SlomoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" strokeLinecap="round" />
    </svg>
  );
}
function DiceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
function RewindIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M11 7l-6 5 6 5V7z" strokeLinejoin="round" />
      <path d="M19 7l-6 5 6 5V7z" strokeLinejoin="round" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M9 13l6-3M9 11l6 3" strokeLinecap="round" />
      <circle cx="7" cy="12" r="2.4" />
      <circle cx="17" cy="7" r="2.4" />
      <circle cx="17" cy="17" r="2.4" />
    </svg>
  );
}
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
      {off ? <path d="M4 4l16 16" strokeLinecap="round" /> : null}
    </svg>
  );
}

const chip =
  'flex items-center justify-center rounded-xl border border-white/10 bg-[#1c1f26]/90 text-[#a7a399] shadow-lg backdrop-blur-sm transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#f26a2e]/60';

export default function HUD({
  type,
  size,
  slomo,
  hidden,
  dim,
  onType,
  onSize,
  onSlomo,
  onRegenerate,
  onReset,
  onShare,
  onToggleHud,
}: {
  type: MeteorType;
  size: MeteorSize;
  slomo: boolean;
  hidden: boolean;
  dim: boolean;
  seed: number;
  onType: (t: MeteorType) => void;
  onSize: (s: MeteorSize) => void;
  onSlomo: (on: boolean) => void;
  onRegenerate: () => void;
  onReset: () => void;
  onShare: () => void;
  onToggleHud: () => void;
}) {
  // hide-UI eye is always available (top-right)
  const eye = (
    <button
      aria-label={hidden ? 'UI 표시' : 'UI 숨김'}
      onClick={onToggleHud}
      className={`${chip} pointer-events-auto fixed right-4 top-4 z-40 h-10 w-10`}
    >
      <EyeIcon off={hidden} />
    </button>
  );

  if (hidden) return eye;

  return (
    <div
      className={`hud-fade ${dim ? 'opacity-25' : 'opacity-100'}`}
      onPointerEnter={() => {
        /* hover keeps it awake via App's pointermove */
      }}
    >
      {eye}

      {/* bottom control cluster */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2.5 px-3">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2.5">
          {/* meteor palette */}
          <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-[#1c1f26]/90 p-1.5 shadow-lg backdrop-blur-sm">
            {METEOR_TYPES.map((t) => {
              const Icon = ICONS[t];
              const active = t === type;
              return (
                <button
                  key={t}
                  onClick={() => onType(t)}
                  aria-label={METEOR_PRESETS[t].label}
                  title={METEOR_PRESETS[t].label}
                  className={`relative flex h-10 w-11 flex-col items-center justify-center rounded-xl transition-all ${
                    active ? '-translate-y-0.5 text-[#f2eee6]' : 'text-[#a7a399] hover:text-[#d8d3c8]'
                  }`}
                >
                  <Icon />
                  {active ? (
                    <span className="absolute bottom-1 h-0.5 w-5 rounded-full bg-[#f26a2e]" />
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* size segmented */}
          <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-[#1c1f26]/90 p-1.5 shadow-lg backdrop-blur-sm">
            {METEOR_SIZES.map((s) => {
              const active = s === size;
              return (
                <button
                  key={s}
                  onClick={() => onSize(s)}
                  aria-label={`크기 ${s}`}
                  className={`h-10 w-9 rounded-xl text-sm font-medium transition-colors ${
                    active ? 'bg-[#f26a2e] text-[#1c1f26]' : 'text-[#a7a399] hover:bg-white/5'
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>

          {/* slomo */}
          <button
            onClick={() => onSlomo(!slomo)}
            aria-label="슬로모"
            title="슬로모 — 임팩트 감상"
            className={`${chip} pointer-events-auto h-[52px] w-[52px] ${
              slomo ? 'text-[#f26a2e]' : 'text-[#a7a399]'
            }`}
          >
            <SlomoIcon />
          </button>

          {/* regen / reset / share — slightly separated to avoid mis-taps */}
          <div className="ml-1 flex items-center gap-2 sm:ml-3">
            <button onClick={onRegenerate} aria-label="새 도시" title="새 도시 (재생성)" className={`${chip} h-[52px] w-[52px] text-[#d8d3c8]`}>
              <DiceIcon />
            </button>
            <button onClick={onReset} aria-label="리셋" title="리셋 (파편 지우기)" className={`${chip} h-11 w-11`}>
              <RewindIcon />
            </button>
            <button onClick={onShare} aria-label="공유" title="시드 링크 복사" className={`${chip} h-11 w-11`}>
              <ShareIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
