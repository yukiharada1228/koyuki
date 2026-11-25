import { isPlainRecord } from './snapshot.js';

/** Internal registration boundary: never omit typed own data keys or evaluate getters. */
export function operationEntries<T extends object>(table: T): [string, T[keyof T]][] {
  if (!isPlainRecord(table)) throw new TypeError('OperationTableRequiresPlainRecord');
  const descriptors = Object.getOwnPropertyDescriptors(table);
  const entries: [string, T[keyof T]][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
    if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new TypeError('OperationTableRequiresStringDataKeys');
    entries.push([key, descriptor.value]);
  }
  return entries;
}
export type OperationName<K> = K extends string ? K : K extends number ? number extends K ? string : `${K}` : never;
