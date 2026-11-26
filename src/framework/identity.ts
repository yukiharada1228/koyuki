// Reject values for which JSON would silently lose identity information.
export function canonicalIdentity(input: unknown): string {
  const seen = new Set<object>();
  function normalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== 'object' || value === null) throw new Error('NonSerializableInput');
    if (seen.has(value)) throw new Error('CyclicInput');
    seen.add(value);
    try {
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
        throw new Error('NonPlainInput');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string')) throw new Error('SymbolInput');
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('NonSerializableInput');
      }
      if (array) {
        const length = descriptors.length!.value as number;
        if (keys.length !== length + 1 || keys.some(key => key !== 'length' &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new Error('NonSerializableInput');
        return Array.from({ length }, (_, index) => normalize(descriptors[String(index)]!.value));
      }
      return Object.fromEntries((keys as string[]).sort().map(key => [key, normalize(descriptors[key]!.value)]));
    } finally { seen.delete(value); }
  }
  return JSON.stringify(normalize(input));
}
