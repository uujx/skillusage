const forbidden = [
  /\bBearer\s+[A-Za-z0-9._-]+/i,
  /\b(?:sk|pk|ghp|phc|phx)_[A-Za-z0-9_-]{12,}/i,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
  /(?:^|[\s"'=:])\/(?:private|tmp|var|etc|opt|usr)\//m,
  /[A-Za-z]:\\Users\\[^\\]+\\/,
  /https?:\/\/[^\s]+\?[^\s]+/i,
];

export function assertSafeOutput(output: string): void {
  if (forbidden.some((pattern) => pattern.test(output))) throw new Error("unsafe report output");
}
