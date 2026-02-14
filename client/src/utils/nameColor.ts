const NAME_COLORS = [
  "#0000FF", "#FF0000", "#008000", "#800080", "#D26900",
  "#008080", "#4B0082", "#B22222", "#006400", "#8B008B",
];

export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return NAME_COLORS[Math.abs(h) % NAME_COLORS.length];
}

export function buddyIconColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}
