// Minimal hand-rolled line icons — matches the blueprint's "consistent
// line-icon set" without adding an icon package dependency (a handful of
// small strokes cover this, no library needed).
type IconProps = { className?: string };

function base(paths: React.ReactNode) {
  return function Icon({ className }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };
}

export const OverviewIcon = base(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);

export const MeetingsIcon = base(
  <>
    <rect x="3" y="4.5" width="18" height="16" rx="2" />
    <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
  </>,
);

export const PeopleIcon = base(
  <>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
    <path d="M16 4.3c1.6.5 2.75 2 2.75 3.7 0 1.7-1.15 3.2-2.75 3.7M18.5 13.6c2 .8 3.5 2.9 3.5 5.4" />
  </>,
);

export const TeamsIcon = base(
  <>
    <path d="M4 21V8l8-5 8 5v13" />
    <path d="M9 21v-6h6v6M4 12h16" />
  </>,
);

export const IntegrationsIcon = base(
  <>
    <path d="M9 3v4M15 3v4M9 17v4M15 17v4" />
    <rect x="6" y="7" width="12" height="10" rx="2" />
  </>,
);

export const ExceptionsIcon = base(
  <>
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17h.01" />
  </>,
);

export const PoliciesIcon = base(
  <path d="M12 2 4 5v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V5l-8-3ZM8.5 12l2.5 2.5 4.5-4.5" />,
);

export const AuditIcon = base(
  <>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M15 3v4h4M9 12h6M9 16h6" />
  </>,
);

export const SettingsIcon = base(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </>,
);
