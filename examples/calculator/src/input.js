export function validateNumber(value) {
  if (!Number.isFinite(value)) throw new Error('A finite number is required');
  return value;
}

export function parseInput(text) {
  if (String(text).trim() === '') throw new Error('Input cannot be empty');
  return validateNumber(Number(text));
}
