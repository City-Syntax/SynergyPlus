export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Synergy Orbit — the EnergyPlus swoosh closed into a full orbit, worker
          nodes converging on a central blue "+" hub. Canonical mark; see
          assets/logo/synergyplus-icon.svg. */}
      <svg className="h-7 w-7" viewBox="0 0 256 256" fill="none" role="img" aria-label="SynergyPlus logo">
        <ellipse cx="128" cy="128" rx="98" ry="58" transform="rotate(-28 128 128)" stroke="#009D57" strokeWidth="9" strokeLinecap="round" />
        <g fill="#0E9E8E">
          <circle cx="44" cy="92" r="15" />
          <circle cx="212" cy="164" r="15" />
          <circle cx="150" cy="46" r="13" />
        </g>
        <g stroke="#0E9E8E" strokeWidth="6" strokeLinecap="round" opacity="0.55">
          <line x1="44" y1="92" x2="120" y2="120" />
          <line x1="212" y1="164" x2="136" y2="136" />
          <line x1="150" y1="46" x2="124" y2="116" />
        </g>
        <circle cx="128" cy="128" r="40" fill="#0082C4" />
        <g fill="#ffffff">
          <rect x="121" y="104" width="14" height="48" rx="4" />
          <rect x="104" y="121" width="48" height="14" rx="4" />
        </g>
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">
        Synergy<span className="text-brand">Plus</span>
      </span>
    </div>
  );
}
