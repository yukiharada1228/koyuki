// DTO policy of these demonstration adapters, not a restriction of core business.
// structuredClone silently drops prototypes, Symbol keys and hidden properties.
export function assertStorageData(value: unknown): void {
  const active = new WeakSet<object>(), checked = new WeakSet<object>();
  function unsupported(): never { throw new DOMException('Procurement storage requires plain JSON data', 'DataCloneError'); }
  function inspect(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) unsupported();
    if (active.has(item)) unsupported();
    if (checked.has(item)) return;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype)) unsupported();
    const keys = Reflect.ownKeys(item);
    const length: unknown = array ? Object.getOwnPropertyDescriptor(item, 'length')?.value : undefined;
    if (array && (typeof length !== 'number' || keys.length !== length + 1)) unsupported();
    active.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') unsupported();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || typeof length !== 'number' || Number(key) >= length)) unsupported();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) unsupported();
      inspect(descriptor.value);
    }
    active.delete(item); checked.add(item);
  }
  inspect(value);
}
