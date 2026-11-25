// Internal ownership boundary shared by the event loop, replay runtime and capture.
// Not exported from the package entry point.
function unsupported(): Error {
  const error = new Error('Snapshot data is not cloneable');
  error.name = 'DataCloneError';
  return error;
}

// Owned data must not silently erase validation evidence or invoke accessors.
// This boundary accepts data formats, not arbitrary objects with behavior.
export function snapshotData<I>(input: I): I {
  try { return copyData(input); } catch { throw unsupported(); }
}
/** Internal declaration-table check; accepts native plain records across realms. */
export function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || samePrototype(prototype, Object.prototype);
}
function sameValue(actual: unknown, standard: unknown): boolean {
  if (Object.is(actual, standard)) return true;
  if (typeof actual === 'function' && typeof standard === 'function')
    return Function.prototype.toString.call(actual) === Function.prototype.toString.call(standard);
  return actual !== null && standard !== null && typeof actual === 'object' && typeof standard === 'object'
    && samePrototype(Object.getPrototypeOf(actual), Object.getPrototypeOf(standard)) && sameFields(actual, standard);
}
function sameFields(source: object, expected: object): boolean {
  const fields = Object.getOwnPropertyDescriptors(source), nativeFields = Object.getOwnPropertyDescriptors(expected);
  const keys = Reflect.ownKeys(fields);
  if (keys.length !== Reflect.ownKeys(nativeFields).length) return false;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(fields, key)?.value as PropertyDescriptor | undefined;
    const standard = Object.getOwnPropertyDescriptor(nativeFields, key)?.value as PropertyDescriptor | undefined;
    if (!field || !standard || !(['value', 'get', 'set'] as const).every(part => sameValue(field[part], standard[part]))) return false;
  }
  return true;
}
function samePrototype(source: object | null, expected: object | null): boolean {
  if (source === expected) return true;
  if (source === null || expected === null) return false;
  const actual = Object.getOwnPropertyDescriptor(source, 'constructor')?.value;
  const native = Object.getOwnPropertyDescriptor(expected, 'constructor')?.value;
  return typeof actual === 'function' && typeof native === 'function' && sameValue(actual, native)
    && sameFields(source, expected) && samePrototype(Object.getPrototypeOf(source), Object.getPrototypeOf(expected));
}
function copyData<I>(input: I): I {
  const seen = new Set<object>();
  let nullPrototype = false;
  const typed = new Set<object>([Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
    Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype, Uint32Array.prototype,
    Float32Array.prototype, Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype]);
  function inspect(value: unknown): void {
    if (value === null || typeof value === 'undefined' || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') return;
    if (typeof value !== 'object') throw unsupported();
    if (seen.has(value)) return;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value), array = Array.isArray(value);
    const plain = samePrototype(prototype, Object.prototype) || prototype === null, date = samePrototype(prototype, Date.prototype);
    const map = samePrototype(prototype, Map.prototype), set = samePrototype(prototype, Set.prototype);
    const regexp = samePrototype(prototype, RegExp.prototype), buffer = samePrototype(prototype, ArrayBuffer.prototype);
    const view = ArrayBuffer.isView(value) && (samePrototype(prototype, DataView.prototype) || (typed.has(prototype) || [...typed].some(expected => samePrototype(prototype, expected))));
    if (!(plain || array && samePrototype(prototype, Array.prototype) || date || map || set || regexp || buffer || view)) throw unsupported();
    if (prototype === null) nullPrototype = true;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw unsupported();
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, 'value')) throw unsupported();
      if (array && key === 'length') continue;
      if (regexp && key === 'lastIndex' && descriptor.value === 0) continue;
      if (!(plain || array || view && !samePrototype(prototype, DataView.prototype) && /^(0|[1-9][0-9]*)$/.test(key))) throw unsupported();
      if (!descriptor.enumerable) throw unsupported();
      inspect(descriptor.value);
    }
    if (map) for (const [key, item] of Map.prototype.entries.call(value)) { inspect(key); inspect(item); }
    if (set) for (const item of Set.prototype.values.call(value)) inspect(item);
    if (view) {
      // Only an ArrayBuffer provides detached ownership; SharedArrayBuffer does not.
      const source = (value as ArrayBufferView).buffer;
      Reflect.apply(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!, source, []);
      inspect(source);
    }
  }
  inspect(input);
  const request = structuredClone(input);
  const copied = new Set<object>();
  // Native cloning reveals shared buffers even when their original prototype was
  // replaced. Check collection contents and view buffers before any host callback.
  function detached(value: unknown): void {
    if (value === null || typeof value !== 'object' || copied.has(value)) return;
    copied.add(value);
    if (ArrayBuffer.isView(value)) { detached(value.buffer); return; }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      let shared = false;
      if (typeof SharedArrayBuffer !== 'undefined') {
        try { Reflect.apply(Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!, value, []); shared = true; }
        catch { /* Not a shared buffer. */ }
      }
      if (shared) throw unsupported();
      let entries: IterableIterator<[unknown, unknown]> | undefined;
      try { entries = Map.prototype.entries.call(value); } catch { /* Not a Map. */ }
      if (entries) { for (const [key, item] of entries) { detached(key); detached(item); } return; }
      let values: IterableIterator<unknown> | undefined;
      try { values = Set.prototype.values.call(value); } catch { /* Not a Set. */ }
      if (values) { for (const item of values) detached(item); return; }
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (Object.hasOwn(descriptor, 'value')) detached(descriptor.value);
    }
  }
  detached(request);
  if (nullPrototype) {
    const restored = new Set<object>();
    function restore(source: unknown, target: unknown): void {
      if (source === null || typeof source !== 'object' || target === null || typeof target !== 'object' || restored.has(source)) return;
      restored.add(source);
      const prototype = Object.getPrototypeOf(source);
      if (prototype === null) Object.setPrototypeOf(target, null);
      if (samePrototype(prototype, Map.prototype)) {
        const entries = Map.prototype.entries.call(target);
        for (const [key, value] of Map.prototype.entries.call(source)) {
          const copy = entries.next().value; if (!copy) throw unsupported();
          restore(key, copy[0]); restore(value, copy[1]);
        }
      } else if (samePrototype(prototype, Set.prototype)) {
        const values = Set.prototype.values.call(target);
        for (const value of Set.prototype.values.call(source)) restore(value, values.next().value);
      } else if (ArrayBuffer.isView(source) && ArrayBuffer.isView(target)) restore(source.buffer, target.buffer);
      const copies = Object.getOwnPropertyDescriptors(target);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
        if (Object.hasOwn(descriptor, 'value') && copies[key] && Object.hasOwn(copies[key], 'value')) restore(descriptor.value, copies[key]!.value);
      }
    }
    restore(input, request);
  }
  return request;
}

