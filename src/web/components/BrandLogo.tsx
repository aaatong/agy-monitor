export function BrandLogo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      class="shrink-0"
    >
      <defs>
        <linearGradient id="agyLogoBg" x1="28" y1="24" x2="228" y2="232" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#1b2232" />
          <stop offset="100%" stop-color="#111621" />
        </linearGradient>
        <linearGradient id="agyLogoArc" x1="68" y1="178" x2="196" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#5b9cf6" />
          <stop offset="100%" stop-color="#3fb98f" />
        </linearGradient>
      </defs>
      <rect x="14" y="14" width="228" height="228" rx="54" fill="url(#agyLogoBg)" />
      <rect x="16" y="16" width="224" height="224" rx="52" stroke="#334155" stroke-width="5" />
      <path
        d="M 72 184 A 80 80 0 1 1 184 184"
        stroke="#2a3447"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        d="M 72 184 A 80 80 0 1 1 201 98"
        stroke="url(#agyLogoArc)"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        d="M 66 140 L 95 140 L 110 104 L 128 160 L 146 116 L 159 140 L 190 140"
        stroke="#e2e8f0"
        stroke-width="11"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="201" cy="98" r="7" fill="#3fb98f" />
    </svg>
  );
}
