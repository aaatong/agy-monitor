export function BrandLogo({ size = 20 }: { size?: number }) {
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
        <linearGradient
          id="agyBrandGradArch"
          x1="42"
          y1="150"
          x2="214"
          y2="106"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stop-color="#2563eb" />
          <stop offset="35%" stop-color="#3186ff" />
          <stop offset="70%" stop-color="#4da3e8" />
          <stop offset="100%" stop-color="#38bdf8" />
        </linearGradient>
        <linearGradient
          id="agyBrandGradPulse"
          x1="90"
          y1="154"
          x2="166"
          y2="154"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stop-color="#0ea5e9" />
          <stop offset="55%" stop-color="#14b8a6" />
          <stop offset="100%" stop-color="#2dd4bf" />
        </linearGradient>
        <radialGradient
          id="agyBrandGradNode"
          cx="195"
          cy="50"
          r="16"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stop-color="#7dd3fc" />
          <stop offset="52%" stop-color="#3186ff" />
          <stop offset="100%" stop-color="#1d4ed8" />
        </radialGradient>
      </defs>
      <path
        d="M 128 34 C 102 34 82 64 66 114 C 51 160 40 186 40 204 C 40 216 49 222 59 222 C 69 222 75 215 79 202 C 88 164 102 110 112 86 C 118 73 123 70 128 70 C 133 70 138 73 144 86 C 154 110 168 164 177 202 C 181 215 187 222 197 222 C 207 222 216 216 216 204 C 216 186 205 160 190 114 C 174 64 154 34 128 34 Z"
        fill="url(#agyBrandGradArch)"
      />
      <path
        d="M 92 156 L 106 156 L 118 124 L 134 180 L 147 142 L 156 156 L 166 156"
        stroke="url(#agyBrandGradPulse)"
        stroke-width="14"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="198" cy="54" r="12" fill="url(#agyBrandGradNode)" />
    </svg>
  );
}
