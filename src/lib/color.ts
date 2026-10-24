export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export const normalizeHex = (value: string) => value.toLowerCase();
function luminance(hex: string) {
  if (!isHexColor(hex)) throw new TypeError('El color debe tener el formato #RRGGBB.');
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function contrastRatio(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function readableTextColor(hex: string): '#ffffff' | '#111111' {
  return contrastRatio(hex, '#ffffff') > contrastRatio(hex, '#111111') ? '#ffffff' : '#111111';
}
