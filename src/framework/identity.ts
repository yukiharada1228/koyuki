// Reject values for which JSON would silently lose identity information.
export function canonicalIdentity(input: unknown): string {
  const seen = new Set<object>();
  function normalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) throw new Error('NonSerializableInput');
    if (seen.has(value)) throw new Error('CyclicInput');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(normalize);
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new Error('NonPlainInput');
      if (Object.getOwnPropertySymbols(value).length) throw new Error('SymbolInput');
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize((value as Record<string, unknown>)[key])]));
    } finally { seen.delete(value); }
  }
  return JSON.stringify(normalize(input));
}
