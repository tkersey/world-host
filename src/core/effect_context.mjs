export const DEFAULT_EFFECT_CONTEXT_MARK = Symbol.for('world-host.default-effect-context');

const CONTROLLER_EFFECT_CONTEXT_KEYS = new Set([
  'application',
  'branchId',
  'driverManifest',
  'hostRequest',
  'options',
  'parentClosureBytes',
  'parentHead',
  'run',
  'worker',
  'worldHostRequest',
]);

export function markDefaultEffectContext(context) {
  if (context && typeof context === 'object') {
    Object.defineProperty(context, DEFAULT_EFFECT_CONTEXT_MARK, { value: true });
  }
  return context;
}

export function isDefaultEffectContext(context) {
  return Boolean(context && typeof context === 'object' && context[DEFAULT_EFFECT_CONTEXT_MARK] === true);
}

export function receiverLocalEffectContext(context) {
  if (!context || typeof context !== 'object') return context;
  const receiverLocal = {
    ...(context.action === undefined ? {} : { action: context.action }),
    ...(context.policy === undefined ? {} : { policy: context.policy }),
  };
  if (isDefaultEffectContext(context)) return receiverLocal;
  for (const [key, value] of Object.entries(context)) {
    if (key === 'action' || key === 'policy' || CONTROLLER_EFFECT_CONTEXT_KEYS.has(key)) continue;
    receiverLocal[key] = value;
  }
  return receiverLocal;
}
