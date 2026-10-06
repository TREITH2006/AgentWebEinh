export interface ScreenshotCapture {
  dataUrl: string;
  capturedAt: number;
}

export function isScreenshotCapture(value: unknown): value is ScreenshotCapture {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScreenshotCapture>;
  return (
    typeof candidate.dataUrl === 'string' &&
    candidate.dataUrl.startsWith('data:image/') &&
    typeof candidate.capturedAt === 'number'
  );
}
