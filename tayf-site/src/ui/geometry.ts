export interface Point { x: number; y: number }
export interface RectLike { left: number; top: number; width: number; height: number }
export function pointerToViewBox(clientX: number, clientY: number, rect: RectLike, viewWidth: number, viewHeight: number): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return { x: (clientX - rect.left) * viewWidth / rect.width, y: (clientY - rect.top) * viewHeight / rect.height };
}
export function clampComponentPosition(x: number, y: number, width = 760, height = 390): Point {
  return { x: Math.max(65, Math.min(width - 70, x)), y: Math.max(55, Math.min(height - 75, y)) };
}
