/**
 * Translate the stored `monitor` setting into a monitor index.
 *
 * "primary" (the default) and anything unparsable mean "let the backend pick
 * the primary display", which the commands encode as `null`.
 */
export function targetMonitorIndex(monitor: string | undefined | null): number | null {
  if (!monitor || monitor === "primary") return null;
  const index = Number.parseInt(monitor, 10);
  return Number.isFinite(index) && index >= 0 ? index : null;
}