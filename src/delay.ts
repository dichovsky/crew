/**
 * The real wall-clock delay used by the Launcher and Relay poll loops. Both
 * inject an instant delay through the same seam in tests, so the loop branches
 * run without real waits; production uses this single implementation.
 */
export function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
