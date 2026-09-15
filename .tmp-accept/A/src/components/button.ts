export const BUTTON_LABEL = 'Pay';

export function labelFor(count: number): string {
  return count > 1 ? `${count} items` : BUTTON_LABEL;
}
