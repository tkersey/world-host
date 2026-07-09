const NativeArray = Array;
const NativeMap = Map;
const NativeProxy = Proxy;
const NativeSet = Set;
const NativeWeakMap = WeakMap;
const APPLY = Reflect.apply;
const GET = Reflect.get;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_VALUES = Array.prototype.values;
const FUNCTION_BIND = Function.prototype.bind;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const SET_ADD = Set.prototype.add;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const SET_FOR_EACH = Set.prototype.forEach;
const SET_VALUES = Set.prototype.values;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const ARRAY_ITERATOR_NEXT = GET_PROTOTYPE_OF(APPLY(ARRAY_VALUES, new NativeArray(), [])).next;
const SET_ITERATOR_NEXT = GET_PROTOTYPE_OF(APPLY(SET_VALUES, new NativeSet(), [])).next;
const READ_ONLY_METHODS = new NativeMap();
const IMMUTABLE_SET_TARGETS = new NativeWeakMap();
for (const property of [
  'has',
  'entries',
  'keys',
  'values',
  Symbol.iterator,
  'difference',
  'intersection',
  'isDisjointFrom',
  'isSubsetOf',
  'isSupersetOf',
  'symmetricDifference',
  'union',
]) {
  const method = NativeSet.prototype[property];
  if (typeof method === 'function') APPLY(MAP_SET, READ_ONLY_METHODS, [property, method]);
}

export function immutableSet(values = []) {
  const target = new NativeSet();
  addIterableValues(target, values);
  return immutableSetProxy(target);
}

export function immutablePolicySet(value, mapValue = identity) {
  const target = new NativeSet();
  const values = policyValues(value);
  addArrayValues(target, values, mapValue);
  return immutableSetProxy(target);
}

function immutableSetProxy(target) {
  FREEZE(target);

  const methodCache = new NativeMap();
  let proxy;
  proxy = new NativeProxy(target, {
    get(set, property, receiver) {
      if (property === 'size') return APPLY(SET_SIZE, set, []);
      if (property === 'add' || property === 'delete' || property === 'clear') {
        return cachedMethod(methodCache, property, () => function immutableSetMutation() {
          throw new TypeError('Cannot mutate an immutable Set');
        });
      }
      if (property === 'forEach') {
        return cachedMethod(methodCache, property, () => function immutableSetForEach(callback, thisArg) {
          if (typeof callback !== 'function') throw new TypeError('Set forEach callback must be a function');
          APPLY(SET_FOR_EACH, set, [(value, key) => {
            APPLY(callback, thisArg, [value, key, proxy]);
          }]);
        });
      }

      const method = APPLY(MAP_GET, READ_ONLY_METHODS, [property]);
      if (method) {
        return cachedMethod(methodCache, method, () => APPLY(FUNCTION_BIND, method, [set]));
      }
      return GET(set, property, receiver);
    },
    set() {
      throw new TypeError('Cannot mutate an immutable Set');
    },
    defineProperty() {
      throw new TypeError('Cannot mutate an immutable Set');
    },
    deleteProperty() {
      throw new TypeError('Cannot mutate an immutable Set');
    },
  });
  APPLY(WEAK_MAP_SET, IMMUTABLE_SET_TARGETS, [proxy, target]);
  return proxy;
}

function policyValues(value) {
  const values = new NativeArray();
  if (value == null) return values;
  if (ARRAY_IS_ARRAY(value)) {
    collectIteratorValues(values, APPLY(ARRAY_VALUES, value, []), ARRAY_ITERATOR_NEXT);
    return values;
  }
  const immutableTarget = APPLY(WEAK_MAP_GET, IMMUTABLE_SET_TARGETS, [value]);
  if (immutableTarget) {
    collectIteratorValues(values, APPLY(SET_VALUES, immutableTarget, []), SET_ITERATOR_NEXT);
    return values;
  }
  let iterator;
  try {
    iterator = APPLY(SET_VALUES, value, []);
  } catch {
    defineArrayValue(values, 0, value);
    return values;
  }
  collectIteratorValues(values, iterator, SET_ITERATOR_NEXT);
  return values;
}

function addIterableValues(target, values) {
  if (values == null) return;
  if (ARRAY_IS_ARRAY(values)) {
    addIteratorValues(target, APPLY(ARRAY_VALUES, values, []), ARRAY_ITERATOR_NEXT, identity);
    return;
  }
  const immutableTarget = APPLY(WEAK_MAP_GET, IMMUTABLE_SET_TARGETS, [values]);
  if (immutableTarget) {
    addIteratorValues(target, APPLY(SET_VALUES, immutableTarget, []), SET_ITERATOR_NEXT, identity);
    return;
  }
  let iterator;
  try {
    iterator = APPLY(SET_VALUES, values, []);
  } catch {
    const iteratorMethod = GET(values, Symbol.iterator);
    const genericIterator = APPLY(iteratorMethod, values, []);
    const next = GET(genericIterator, 'next');
    addIteratorValues(target, genericIterator, next, identity);
    return;
  }
  addIteratorValues(target, iterator, SET_ITERATOR_NEXT, identity);
}

function collectIteratorValues(values, iterator, next) {
  let index = 0;
  while (true) {
    const step = APPLY(next, iterator, []);
    if (step.done) return;
    defineArrayValue(values, index, step.value);
    index += 1;
  }
}

function defineArrayValue(values, index, value) {
  DEFINE_PROPERTY(values, index, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function addArrayValues(target, values, mapValue) {
  addIteratorValues(target, APPLY(ARRAY_VALUES, values, []), ARRAY_ITERATOR_NEXT, mapValue);
}

function addIteratorValues(target, iterator, next, mapValue) {
  while (true) {
    const step = APPLY(next, iterator, []);
    if (step.done) return;
    APPLY(SET_ADD, target, [mapValue(step.value)]);
  }
}

function identity(value) {
  return value;
}

function cachedMethod(cache, property, create) {
  if (!APPLY(MAP_HAS, cache, [property])) APPLY(MAP_SET, cache, [property, create()]);
  return APPLY(MAP_GET, cache, [property]);
}
