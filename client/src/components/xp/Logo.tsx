export function LogoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
      <circle cx="20" cy="5" r="3.5" fill="#FFD700" />
      <path d="M18 9L14 20" stroke="#FFD700" strokeWidth="3" strokeLinecap="round" />
      <path d="M17 12L22 16L26 13" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 12L10 14L8 11" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 20L20 26L24 25" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 20L8 25L5 28" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
