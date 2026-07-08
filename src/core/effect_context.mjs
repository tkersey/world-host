export const DEFAULT_EFFECT_CONTEXT_MARK = Symbol.for('world-host.default-effect-context');

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
  if (!isDefaultEffectContext(context)) return context;
  return {
    ...(context.action === undefined ? {} : { action: context.action }),
    ...(context.policy === undefined ? {} : { policy: context.policy }),
  };
}
