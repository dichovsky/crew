/** Cut text on Unicode code-point boundaries, marking only an actual cut. */
export function previewText(text: string, maximum = 200): string {
  const points = Array.from(text);
  return points.length <= maximum ? text : `${points.slice(0, maximum).join('')}…`;
}
