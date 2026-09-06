/* eslint-disable @next/next/no-img-element -- the brand mark is a small, non-rasterized SVG asset */
export function BrandIcon({ size = 32, framed = false }: { size?: number; framed?: boolean }) {
  return <img className={framed ? "brand-icon brand-icon-framed" : "brand-icon"} src={framed ? "/icon.svg" : "/logo-mark.svg"} width={size} height={size} alt="" aria-hidden="true" />;
}
