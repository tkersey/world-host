import { EffectRecoveryClass, ResponseStatusCode, assertRecoveryClass } from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';
import { carrierManifest } from '../protocol/world_manifest.mjs';

export const world_host_capability_pack_format_version = 1;
export const world_host_capability_driver_abi_version = 1;

const RECOVERY_CLASSES = new Set(Object.values(EffectRecoveryClass));
const RESPONSE_STATUSES = new Set(Object.keys(ResponseStatusCode));
const SEMANTIC_FIELDS = Object.freeze([
  'formatVersion',
  'packageName',
  'packageVersion',
  'driverId',
  'driverAbiVersion',
  'supportedWorldProtocolVersion',
  'supportedApplianceAbiVersion',
  'supportedTurnClosureVersion',
  'supportedActuatorRefs',
  'supportedDescriptorFingerprints',
  'supportedActuationClasses',
  'supportedResponseStatuses',
  'recoveryClass',
  'canDryRun',
  'canShadow',
  'canReplay',
  'canRecover',
  'propagatesWorldIdempotencyKey',
  'requiresApproval',
  'requiredSecrets',
  'authorityLabels',
  'policyRequirements',
  'maximumRequestBytes',
  'maximumResponseBytes',
  'conformanceCorpusFingerprint',
  'metadataBytes',
  'adapter',
]);
const SECRET_PATTERN = /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i;
const CONFORMANCE_RECEIPT_PATH = 'conformance.json';
const ADAPTER_IMPORT_SCANNER = globalThis.Bun?.Transpiler ? new globalThis.Bun.Transpiler({ loader: 'js' }) : null;
const SIDECAR_RUNTIME_WRAPPERS = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'command',
  'csh',
  'dash',
  'env',
  'fish',
  'ksh',
  'nohup',
  'powershell',
  'powershell.exe',
  'pwsh',
  'sh',
  'tcsh',
  'time',
  'zsh',
]);
const SIDECAR_JS_RUNTIMES = new Set(['bun', 'node', 'deno']);
const SIDECAR_INLINE_EVAL_RUNTIMES = new Set([
  'bun',
  'deno',
  'lua',
  'luajit',
  'node',
  'perl',
  'php',
  'ruby',
  'rscript',
]);
const SIDECAR_RUNTIME_VALUE_OPTIONS = new Set([
  '--conditions',
  '--config',
  '--config-file',
  '-C',
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--experimental-policy',
  '--heap-prof-dir',
  '--icu-data-dir',
  '--import-map',
  '--openssl-config',
  '--redirect-warnings',
  '--snapshot-blob',
  '--test-reporter-destination',
  '--watch-path',
  '--cert',
]);
const SIDECAR_RUNTIME_FLAG_ONLY_OPTIONS = new Set([
  '--no-warnings',
  '--trace-warnings',
]);
const SIDECAR_PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
  '--cache',
  '--cache-folder',
  '--config',
  '--config-file',
  '--cwd',
  '--dir',
  '--filter',
  '--globalconfig',
  '--modules-folder',
  '--otp',
  '--prefix',
  '--registry',
  '--store-dir',
  '--tag',
  '--userconfig',
  '--workspace',
  '-C',
  '-w',
]);
const SIDECAR_PACKAGE_MANAGER_SCRIPT_COMMANDS = new Set([
  'add',
  'ci',
  'create',
  'dlx',
  'exec',
  'i',
  'init',
  'install',
  'link',
  'rebuild',
  'restart',
  'run',
  'run-script',
  'start',
  'stop',
  'test',
  'update',
  'upgrade',
  'x',
]);

export class CapabilityManifest {
  constructor(fields) {
    Object.assign(this, fields);
    for (const key of [
      'supportedActuatorRefs',
      'supportedDescriptorFingerprints',
      'supportedActuationClasses',
      'supportedResponseStatuses',
      'requiredSecrets',
      'authorityLabels',
      'checksums',
      'docs',
    ]) {
      if (Array.isArray(this[key])) Object.freeze(this[key]);
    }
    Object.freeze(this.policyRequirements);
    Object.freeze(this.adapter);
    Object.freeze(this);
  }
}

export class CapabilityPack {
  constructor({ manifest, conformanceReceipt = null, artifacts = {}, docs = [] } = {}) {
    this.manifest = assertCapabilityManifest(manifest);
    this.conformanceReceipt = conformanceReceipt == null ? null : assertCapabilityConformanceReceipt(conformanceReceipt);
    this.artifacts = Object.freeze({ ...artifacts });
    this.docs = Object.freeze([...docs]);
    Object.freeze(this);
  }
}

export class CapabilityDescriptor {
  constructor(fields) {
    requiredString(fields?.actuatorRef, 'actuatorRef');
    requiredString(fields?.descriptorFingerprint, 'descriptorFingerprint');
    requiredString(fields?.actuationClass, 'actuationClass');
    this.actuatorRef = fields.actuatorRef;
    this.descriptorFingerprint = fields.descriptorFingerprint;
    this.actuationClass = fields.actuationClass;
    this.responseStatuses = requiredKnownResponseStatusList(fields.responseStatuses ?? ['responded'], 'responseStatuses');
    Object.freeze(this.responseStatuses);
    Object.freeze(this);
  }
}

export class CapabilityConformanceReceipt {
  constructor(fields) {
    assertNoConformanceCredentialMaterial(fields);
    requiredString(fields?.driverId, 'driverId');
    requiredString(fields?.packFingerprint, 'packFingerprint');
    requiredString(fields?.corpusFingerprint, 'corpusFingerprint');
    if (!Array.isArray(fields?.vectors) || fields.vectors.length === 0) {
      fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID', 'vectors are required');
    }
    this.driverId = fields.driverId;
    this.packFingerprint = fields.packFingerprint;
    this.corpusFingerprint = fields.corpusFingerprint;
    this.vectors = fields.vectors.map(assertConformanceVector);
    this.nonClaims = fields.nonClaims ?? [];
    Object.freeze(this.vectors);
    Object.freeze(this.nonClaims);
    Object.freeze(this);
  }
}

export function assertCapabilityManifest(input, options = {}) {
  if (!input || typeof input !== 'object') fail('ERR_CAPABILITY_MANIFEST_INVALID');
  assertNoCredentialMaterial(input);
  assertNoMetadataCredentialMaterial(input.metadataBytes);
  const formatVersion = exactInteger(input.formatVersion, 'formatVersion', world_host_capability_pack_format_version);
  const driverAbiVersion = exactInteger(input.driverAbiVersion, 'driverAbiVersion', world_host_capability_driver_abi_version);
  const recoveryClass = assertRecoveryClass(input.recoveryClass);
  const canRecover = requiredBoolean(input.canRecover, 'canRecover');
  if (
    (recoveryClass === EffectRecoveryClass.externallyRecoverable ||
      recoveryClass === EffectRecoveryClass.transactional) &&
    canRecover !== true
  ) {
    fail('ERR_CAPABILITY_MANIFEST_INVALID', 'externally recoverable and transactional drivers must declare canRecover');
  }
  const manifest = new CapabilityManifest({
    formatVersion,
    packFingerprint: optionalFingerprint(input.packFingerprint, 'packFingerprint'),
    packageName: packageName(input.packageName),
    packageVersion: requiredString(input.packageVersion, 'packageVersion'),
    driverId: requiredString(input.driverId, 'driverId'),
    driverAbiVersion,
    supportedWorldProtocolVersion: exactString(input.supportedWorldProtocolVersion, 'supportedWorldProtocolVersion', carrierManifest.supportedWorldRelease),
    supportedApplianceAbiVersion: exactString(input.supportedApplianceAbiVersion, 'supportedApplianceAbiVersion', carrierManifest.applianceAbiVersion),
    supportedTurnClosureVersion: exactString(input.supportedTurnClosureVersion, 'supportedTurnClosureVersion', carrierManifest.turnClosureFormatVersion),
    supportedActuatorRefs: requiredStringList(input.supportedActuatorRefs, 'supportedActuatorRefs'),
    supportedDescriptorFingerprints: requiredStringList(input.supportedDescriptorFingerprints, 'supportedDescriptorFingerprints'),
    supportedActuationClasses: requiredStringList(input.supportedActuationClasses, 'supportedActuationClasses'),
    supportedResponseStatuses: requiredKnownResponseStatusList(input.supportedResponseStatuses, 'supportedResponseStatuses'),
    recoveryClass,
    canDryRun: requiredBoolean(input.canDryRun, 'canDryRun'),
    canShadow: requiredBoolean(input.canShadow, 'canShadow'),
    canReplay: requiredBoolean(input.canReplay, 'canReplay'),
    canRecover,
    propagatesWorldIdempotencyKey: requiredBoolean(input.propagatesWorldIdempotencyKey, 'propagatesWorldIdempotencyKey'),
    requiresApproval: requiredBoolean(input.requiresApproval, 'requiresApproval'),
    requiredSecrets: normalizeSecretDescriptors(input.requiredSecrets ?? []),
    authorityLabels: requiredStringList(input.authorityLabels, 'authorityLabels'),
    policyRequirements: normalizePolicyRequirements(input.policyRequirements ?? {}),
    maximumRequestBytes: requiredPositiveSafeInteger(input.maximumRequestBytes, 'maximumRequestBytes'),
    maximumResponseBytes: requiredPositiveSafeInteger(input.maximumResponseBytes, 'maximumResponseBytes'),
    conformanceCorpusFingerprint: optionalFingerprint(input.conformanceCorpusFingerprint, 'conformanceCorpusFingerprint'),
    metadataBytes: normalizeMetadataBytes(input.metadataBytes ?? ''),
    adapter: normalizeAdapter(input.adapter ?? {}),
    checksums: normalizeChecksums(input.checksums ?? []),
    docs: requiredStringList(input.docs ?? [], 'docs'),
  });
  assertNoCredentialMaterial(manifest);
  assertNoMetadataCredentialMaterial(manifest.metadataBytes);
  assertNoOperationLabelAuthority(manifest);
  if (options.requirePackFingerprint && !manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_REQUIRED');
  return manifest;
}

export async function validateCapabilityPackManifest(input, options = {}) {
  const manifest = assertCapabilityManifest(input, options);
  if (options.verifyFingerprint === true) {
    if (!manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_REQUIRED');
    const actual = await capabilityPackFingerprint(manifest);
    if (actual !== manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_MISMATCH', 'pack fingerprint does not match semantic identity', { expected: manifest.packFingerprint, actual });
  }
  return manifest;
}

export async function capabilityPackFingerprint(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  return `sha256:${await sha256Hex(fromUtf8(stableJson(capabilityManifestSemanticIdentity(manifest))))}`;
}

export function capabilityManifestSemanticIdentity(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  const identity = {};
  for (const key of SEMANTIC_FIELDS) identity[key] = manifest[key];
  identity.artifactChecksums = semanticArtifactChecksums(manifest);
  return identity;
}

export function capabilityDescriptorFromManifest(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  return new CapabilityDescriptor({
    actuatorRef: manifest.supportedActuatorRefs[0],
    descriptorFingerprint: manifest.supportedDescriptorFingerprints[0],
    actuationClass: manifest.supportedActuationClasses[0],
    responseStatuses: manifest.supportedResponseStatuses,
  });
}

export function assertCapabilityConformanceReceipt(input) {
  return new CapabilityConformanceReceipt(input);
}

export async function assertCapabilityPackChecksums(manifestLike, artifacts = {}) {
  const manifest = assertCapabilityManifest(manifestLike);
  assertReferencedArtifactsCovered(manifest);
  for (const item of manifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${item.path}`);
    assertNoArtifactCredentialMaterial(item.path, bytes);
    const actual = `sha256:${await sha256Hex(bytes)}`;
    if (actual !== item.checksum) fail('ERR_CAPABILITY_PACK_CHECKSUM_MISMATCH', `artifact checksum mismatch: ${item.path}`, { expected: item.checksum, actual });
  }
  assertAdapterArtifactSelfContained(manifest, artifacts);
  assertSidecarAdapterArtifactsSelfContained(manifest, artifacts);
  return true;
}

function semanticArtifactChecksums(manifest) {
  return manifest.checksums
    .filter((item) => item.path !== CONFORMANCE_RECEIPT_PATH)
    .map((item) => ({ path: item.path, checksum: item.checksum }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertAdapterArtifactSelfContained(manifest, artifacts) {
  if (manifest.adapter.kind !== 'in_process' || !manifest.adapter.module) return;
  assertJavaScriptAdapterArtifactSelfContained(manifest.adapter.module, artifacts, 'adapter');
}

function assertSidecarAdapterArtifactsSelfContained(manifest, artifacts) {
  if (manifest.adapter.kind !== 'sidecar') return;
  const runtimeEntrypoint = sidecarRuntimeEntrypointArtifact(manifest.adapter.command);
  for (const artifactPath of sidecarCommandArtifacts(manifest.adapter.command)) {
    if (!javascriptArtifactPath(artifactPath) && artifactPath !== runtimeEntrypoint) continue;
    assertJavaScriptAdapterArtifactSelfContained(artifactPath, artifacts, 'sidecar adapter');
  }
}

function assertJavaScriptAdapterArtifactSelfContained(artifactPath, artifacts, label) {
  const bytes = artifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return;
  const text = new TextDecoder().decode(bytes);
  if (!ADAPTER_IMPORT_SCANNER) fail('ERR_CAPABILITY_PACK_ADAPTER_IMPORT_SCAN_UNAVAILABLE', 'adapter import scanning requires Bun.Transpiler');
  let imports;
  try {
    imports = ADAPTER_IMPORT_SCANNER.scanImports(text);
  } catch (error) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_IMPORT_SCAN_FAILED', `adapter import scan failed for ${artifactPath}`, { error: String(error?.message ?? error) });
  }
  if (imports.length || adapterHasImportCall(text)) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT', `${label} imports code outside its checksum-covered entry module: ${artifactPath}`);
  }
}

function assertNoArtifactCredentialMaterial(artifactPath, bytes) {
  if (!textArtifactPath(artifactPath)) return;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  if (artifactCredentialText(text)) fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like artifact content forbidden at ${artifactPath}`);
}

function textArtifactPath(artifactPath) {
  return /\.(?:c?m?js|json|md|txt|ya?ml|toml|ini|conf|cfg|env|pem|crt|cer|key|sh|bash|zsh|fish|py|rb|pl)$/i.test(artifactPath) ||
    /(?:^|[/\\])\.env(?:\.[A-Za-z0-9._-]+)?$/i.test(artifactPath);
}

function javascriptArtifactPath(artifactPath) {
  return /\.c?m?js$/i.test(artifactPath);
}

function artifactCredentialText(text) {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text)) return true;
  if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) return true;
  const scheme = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{8,}={0,2})/ig;
  for (const match of text.matchAll(scheme)) {
    if (!artifactCredentialSentinel(match[1])) return true;
  }
  const assignment = /(?:^|[?&;,\s{])["']?(?:credential|authorization|token|secret|password|(?:api|access|private)[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{8,}={0,2})/ig;
  for (const match of text.matchAll(assignment)) {
    if (!artifactCredentialSentinel(match[1])) return true;
  }
  return false;
}

function artifactCredentialSentinel(value) {
  return /^(?:redacted|opaque|required|none|null|example(?:[-_].*)?|fixture(?:[-_].*)?|no-(?:credentials?|secrets?|tokens?))$/i.test(value);
}

function adapterHasImportCall(text) {
  if (adapterAliasesGlobalObject(text)) return true;
  let previousSignificant = null;
  for (let index = 0; index < text.length;) {
    index = skipWhitespaceAndComments(text, index);
    if (index >= text.length) break;
    const char = text[index];
    if (char === '[') {
      const afterBracket = skipBalancedBracket(text, index);
      const callStart = skipWhitespaceAndComments(text, afterBracket);
      const computedMember = computedMemberAccess(text, index, afterBracket);
      if (computedMember.dangerous || (computedMember.dynamic && dangerousCallAfterCallee(text, callStart))) return true;
      index = afterBracket;
      previousSignificant = ']';
      continue;
    }
    if (char === '\'' || char === '"') {
      const literal = readQuotedString(text, index, char);
      const afterLiteral = skipWhitespaceAndComments(text, literal.end);
      if (
        previousSignificant === '[' &&
        dangerousMemberName(literal.value) &&
        text[afterLiteral] === ']'
      ) {
        const afterBracket = skipWhitespaceAndComments(text, afterLiteral + 1);
        if (dangerousCallAt(text, afterBracket)) return true;
      }
      index = literal.end;
      previousSignificant = 'literal';
      continue;
    }
    if (char === '`') {
      const literal = readTemplateString(text, index);
      const afterLiteral = skipWhitespaceAndComments(text, literal.end);
      if (
        previousSignificant === '[' &&
        (literal.value === null || dangerousMemberName(literal.value)) &&
        text[afterLiteral] === ']'
      ) {
        const afterBracket = skipWhitespaceAndComments(text, afterLiteral + 1);
        if (dangerousCallAt(text, afterBracket)) return true;
      }
      index = literal.end;
      previousSignificant = 'template';
      continue;
    }
    if (!identifierStart(char)) {
      previousSignificant = char;
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < text.length && identifierPart(text[index])) index += 1;
    const identifier = text.slice(start, index);
    const callStart = skipWhitespaceAndComments(text, index);
    if (identifier === 'Reflect' && reflectiveGetterAccess(text, callStart)) return true;
    if (identifier === 'eval' || identifier === 'Function' || identifier === 'getBuiltinModule' ||
      identifier === 'Worker' || identifier === 'SharedWorker') {
      return true;
    }
    if (identifier === 'constructor' && previousSignificant === '.' && text[callStart] === '(') return true;
    if (identifier === 'require') {
      if (text[callStart] !== '(') return true;
      const callEnd = skipBalancedParentheses(text, callStart);
      const afterCall = skipWhitespaceAndComments(text, callEnd);
      if (text[afterCall] === '{') {
        previousSignificant = 'identifier';
        continue;
      }
      return true;
    }
    if (identifier !== 'import') {
      previousSignificant = identifier === 'new' ? 'new' : 'identifier';
      continue;
    }
    if (text[callStart] !== '(') {
      previousSignificant = 'identifier';
      continue;
    }
    const callEnd = skipBalancedParentheses(text, callStart);
    const afterCall = skipWhitespaceAndComments(text, callEnd);
    return true;
  }
  return false;
}

function adapterAliasesGlobalObject(text) {
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
  const globalObject = '(?:globalThis|global|window|self)';
  return new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*${globalObject}\\b`).test(text) ||
    new RegExp(`(?:^|[;{}(),\\n])\\s*${identifier}\\s*=\\s*${globalObject}\\b`).test(text);
}

function dangerousCallAt(text, index) {
  return text[index] === '(' || (text[index] === '?' && text[index + 1] === '.' && text[index + 2] === '(');
}

function dangerousCallAfterCallee(text, index) {
  index = skipWhitespaceAndComments(text, index);
  while (text[index] === ')') index = skipWhitespaceAndComments(text, index + 1);
  return dangerousCallAt(text, index);
}

function computedMemberAccess(text, openBracket, afterBracket) {
  const closeBracket = afterBracket - 1;
  const name = readComputedMemberName(text, openBracket + 1, closeBracket);
  if (name.static) return { dangerous: dangerousMemberName(name.value), dynamic: false };
  return { dangerous: computedGlobalReceiver(text, openBracket), dynamic: true };
}

function dangerousMemberName(value) {
  return value === 'eval' || value === 'Function' || value === 'require' || value === 'constructor' ||
    value === 'getBuiltinModule' || value === 'Worker' || value === 'SharedWorker';
}

function reflectiveGetterAccess(text, index) {
  index = skipWhitespaceAndComments(text, index);
  if (text[index] === '.') {
    index = skipWhitespaceAndComments(text, index + 1);
    const start = index;
    if (!identifierStart(text[index])) return false;
    while (index < text.length && identifierPart(text[index])) index += 1;
    return text.slice(start, index) === 'get';
  }
  if (text[index] !== '[') return false;
  const afterBracket = skipBalancedBracket(text, index);
  const name = readComputedMemberName(text, index + 1, afterBracket - 1);
  return name.static ? name.value === 'get' : true;
}

function readComputedMemberName(text, index, closeBracket) {
  let value = '';
  for (;;) {
    index = skipWhitespaceAndComments(text, index);
    const char = text[index];
    let literal;
    if (char === '\'' || char === '"') {
      literal = readQuotedString(text, index, char);
    } else if (char === '`') {
      literal = readTemplateString(text, index);
      if (literal.value === null) return { static: false, value: null };
    } else {
      return { static: false, value: null };
    }
    value += literal.value;
    index = skipWhitespaceAndComments(text, literal.end);
    if (index === closeBracket) return { static: true, value };
    if (text[index] !== '+') return { static: false, value: null };
    index += 1;
  }
}

function computedGlobalReceiver(text, openBracket) {
  let index = skipWhitespaceAndCommentsBackward(text, openBracket - 1);
  if (text[index] === '.' && text[index - 1] === '?') index = skipWhitespaceAndCommentsBackward(text, index - 2);
  if (index < 0 || !identifierPart(text[index])) return false;
  const end = index + 1;
  while (index >= 0 && identifierPart(text[index])) index -= 1;
  const identifier = text.slice(index + 1, end);
  return identifier === 'globalThis' || identifier === 'global' || identifier === 'window' || identifier === 'self';
}

function skipWhitespaceAndComments(text, index) {
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(index + 2, text.length);
      continue;
    }
    return index;
  }
}

function skipWhitespaceAndCommentsBackward(text, index) {
  for (;;) {
    while (index >= 0 && /\s/.test(text[index])) index -= 1;
    if (text[index] === '/' && text[index - 1] === '*') {
      index -= 2;
      while (index >= 1 && !(text[index - 1] === '/' && text[index] === '*')) index -= 1;
      index -= 2;
      continue;
    }
    return index;
  }
}

function skipQuotedString(text, index, quote) {
  index += 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return index;
}

function readQuotedString(text, index, quote) {
  let value = '';
  index += 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      const escaped = readStringEscape(text, index);
      value += escaped.value;
      index = escaped.end;
      continue;
    }
    if (text[index] === quote) return { value, end: index + 1 };
    value += text[index];
    index += 1;
  }
  return { value, end: index };
}

function readTemplateString(text, index) {
  let value = '';
  let staticLiteral = true;
  index += 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      const escaped = readStringEscape(text, index);
      if (staticLiteral) value += escaped.value;
      index = escaped.end;
      continue;
    }
    if (text[index] === '$' && text[index + 1] === '{') {
      staticLiteral = false;
      index = skipBalancedBrace(text, index + 1);
      continue;
    }
    if (text[index] === '`') return { value: staticLiteral ? value : null, end: index + 1 };
    if (staticLiteral) value += text[index];
    index += 1;
  }
  return { value: staticLiteral ? value : null, end: index };
}

function readStringEscape(text, index) {
  if (index + 1 >= text.length) return { value: '', end: index + 1 };
  const marker = text[index + 1];
  if (marker === '\r' || marker === '\n') {
    const end = marker === '\r' && text[index + 2] === '\n' ? index + 3 : index + 2;
    return { value: '', end };
  }
  if (marker === 'u') {
    if (text[index + 2] === '{') {
      const close = text.indexOf('}', index + 3);
      if (close !== -1) {
        const value = stringEscapeCodePoint(text.slice(index + 3, close));
        if (value !== null) return { value, end: close + 1 };
      }
    } else {
      const value = stringEscapeCodePoint(text.slice(index + 2, index + 6));
      if (value !== null) return { value, end: index + 6 };
    }
  }
  if (marker === 'x') {
    const value = stringEscapeCodePoint(text.slice(index + 2, index + 4));
    if (value !== null) return { value, end: index + 4 };
  }
  return { value: simpleStringEscape(marker), end: index + 2 };
}

function stringEscapeCodePoint(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const codePoint = Number.parseInt(hex, 16);
  if (!Number.isSafeInteger(codePoint)) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

function simpleStringEscape(marker) {
  if (marker === 'b') return '\b';
  if (marker === 'f') return '\f';
  if (marker === 'n') return '\n';
  if (marker === 'r') return '\r';
  if (marker === 't') return '\t';
  if (marker === 'v') return '\v';
  if (marker === '0') return '\0';
  return marker;
}

function skipBalancedBrace(text, index) {
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '`') {
      index = readTemplateString(text, index).end;
      continue;
    }
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipBalancedBracket(text, index) {
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '`') {
      index = readTemplateString(text, index).end;
      continue;
    }
    if (char === '(') {
      index = skipBalancedParentheses(text, index);
      continue;
    }
    if (char === '{') {
      index = skipBalancedBrace(text, index);
      continue;
    }
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipBalancedParentheses(text, index) {
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '`') {
      index = readTemplateString(text, index).end;
      continue;
    }
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function identifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function identifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function assertReferencedArtifactsCovered(manifest) {
  const covered = new Set(manifest.checksums.map((item) => item.path));
  const required = new Set([
    ...manifest.docs,
    ...(manifest.conformanceCorpusFingerprint ? ['conformance.json'] : []),
  ]);
  if (manifest.adapter.kind === 'in_process' && manifest.adapter.module) required.add(manifest.adapter.module);
  if (manifest.adapter.kind === 'sidecar') {
    for (const artifactPath of sidecarCommandArtifacts(manifest.adapter.command)) required.add(artifactPath);
  }
  for (const path of required) {
    if (!covered.has(path)) fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${path}`);
  }
}

function sidecarCommandArtifacts(command) {
  const artifacts = [];
  let entrypointSeen = false;
  for (let index = 0; index < command.length; index += 1) {
    const value = command[index];
    assertSafeSidecarCommandToken(command, index);
    const genericOptionArtifact = sidecarGenericOptionArtifact(value);
    if (genericOptionArtifact && !sidecarRuntimeOptionPosition(command, index)) {
      artifacts.push(genericOptionArtifact);
      continue;
    }
    if (sidecarRuntimeOptionPosition(command, index)) {
      const optionArtifact = sidecarOptionArtifact(value, { allowPreload: !entrypointSeen });
      if (optionArtifact) {
        artifacts.push(optionArtifact);
        continue;
      }
      if (entrypointSeen && genericOptionArtifact) {
        artifacts.push(genericOptionArtifact);
        continue;
      }
      if (!entrypointSeen && sidecarOptionRequiresArtifact(value)) {
        const candidate = command[index + 1];
        if (sidecarPreloadArtifact(candidate)) {
          artifacts.push(candidate);
          index += 1;
          continue;
        }
        fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar preload option must reference a pack-relative checksum-covered artifact: ${value}`);
      }
    }
    if (sidecarCommandArtifact(value)) {
      artifacts.push(value);
      if (!sidecarRuntimeCommandPosition(command, index) && !sidecarRuntimeOptionValuePosition(command, index)) entrypointSeen = true;
    }
  }
  if (!entrypointSeen) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar command must reference a pack-relative checksum-covered entrypoint');
  }
  return artifacts;
}

function sidecarRuntimeCommandPosition(command, index) {
  return index === 0 && SIDECAR_JS_RUNTIMES.has(commandBaseName(command[0]).toLowerCase());
}

function sidecarRuntimeOptionPosition(command, index) {
  return index > 0 && SIDECAR_JS_RUNTIMES.has(commandBaseName(command[0]).toLowerCase());
}

function sidecarOptionArtifact(value, { allowPreload = true } = {}) {
  if (!value.startsWith('-')) return null;
  if (value.startsWith('-r') && value !== '-r') {
    if (!allowPreload) return null;
    const candidate = value.slice(2);
    if (!sidecarPreloadArtifact(candidate)) {
      fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar preload option must reference a pack-relative checksum-covered artifact: ${value}`);
    }
    return candidate;
  }
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  const option = value.slice(0, separator);
  const candidate = value.slice(separator + 1);
  if (sidecarPreloadOption(value)) {
    if (!allowPreload) return null;
    if (!sidecarPreloadArtifact(candidate)) {
      fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar preload option must reference a pack-relative checksum-covered artifact: ${value}`);
    }
  }
  if (SIDECAR_RUNTIME_VALUE_OPTIONS.has(option) && !sidecarCommandArtifact(candidate)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar runtime option must reference a pack-relative checksum-covered artifact: ${value}`);
  }
  return sidecarCommandArtifact(candidate) ? candidate : null;
}

function sidecarOptionRequiresArtifact(value) {
  return sidecarPreloadOptionConsumesNext(value);
}

function sidecarPreloadOption(value) {
  return value === '--import' || value === '--require' || value === '-r' || value === '--preload' ||
    value === '--loader' || value === '--experimental-loader' ||
    value.startsWith('--import=') || value.startsWith('--require=') || value.startsWith('--preload=') ||
    value.startsWith('--loader=') || value.startsWith('--experimental-loader=') ||
    (value.startsWith('-r') && value !== '-r');
}

function sidecarPreloadOptionConsumesNext(value) {
  return value === '--import' || value === '--require' || value === '-r' || value === '--preload' ||
    value === '--loader' || value === '--experimental-loader';
}

function sidecarPreloadArtifact(value) {
  return sidecarCommandArtifact(value) && (value.startsWith('./') || value.startsWith('../'));
}

function assertSafeSidecarCommandToken(command, index) {
  const value = command[index];
  const executable = commandBaseName(value).toLowerCase();
  if (index === 0 && SIDECAR_RUNTIME_WRAPPERS.has(executable)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command wraps runtime execution outside checksum coverage: ${value}`);
  }
  if (index === 0 && ['bunx', 'npx', 'pnpx'].includes(executable)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes packages outside checksum coverage: ${value}`);
  }
  if (sidecarPackageExecBeforeArtifact(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes packages outside checksum coverage: ${command[0]} ${value}`);
  }
  if (sidecarRuntimeEvalFlag(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command evaluates inline code outside checksum coverage: ${value}`);
  }
  if (sidecarRuntimeRemoteEntrypoint(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command uses a remote runtime entrypoint outside checksum coverage: ${value}`);
  }
}

function sidecarRuntimeEvalFlag(command, index) {
  if (index < 1) return false;
  const runtime = commandBaseName(command[0]).toLowerCase();
  if (!sidecarInlineEvalRuntime(runtime)) return false;
  const value = command[index];
  const evalFlag = sidecarInlineEvalFlag(runtime, value);
  if (!evalFlag) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarInlineEvalRuntime(runtime) {
  return SIDECAR_INLINE_EVAL_RUNTIMES.has(runtime) || /^python(?:\d+(?:\.\d+)*)?$/.test(runtime) || /^pypy(?:\d+)?$/.test(runtime);
}

function sidecarInlineEvalFlag(runtime, value) {
  if (typeof value !== 'string') return false;
  if (runtime === 'deno' && value === 'eval') return true;
  if (runtime === 'python' || runtime.startsWith('python') || runtime === 'pypy' || runtime.startsWith('pypy')) {
    return value === '-c' || value.startsWith('-c') || value === '-m' || value.startsWith('-m');
  }
  if (runtime === 'php') return value === '-r' || value.startsWith('-r');
  return value === '-e' || value === '--eval' || value === '-p' || value === '--print' ||
    value.startsWith('-e') || value.startsWith('-p') || value.startsWith('--eval=') || value.startsWith('--print=');
}

function sidecarRuntimeRemoteEntrypoint(command, index) {
  if (!sidecarRuntimeOptionPosition(command, index)) return false;
  if (!sidecarRemoteCommandTarget(command[index])) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarRemoteCommandTarget(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function sidecarRuntimeEntrypointArtifact(command) {
  if (!sidecarRuntimeCommandPosition(command, 0)) return null;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 ? null : command[entrypointIndex];
}

function sidecarEntrypointIndex(command) {
  for (let index = 1; index < command.length; index += 1) {
    const value = command[index];
    if (sidecarOptionArtifact(value)) continue;
    if (sidecarOptionRequiresArtifact(value)) {
      index += 1;
      continue;
    }
    if (sidecarRuntimeOptionValuePosition(command, index)) continue;
    if (sidecarCommandArtifact(value)) return index;
  }
  return -1;
}

function sidecarRuntimeOptionValuePosition(command, index) {
  if (!sidecarRuntimeOptionPosition(command, index)) return false;
  const previous = command[index - 1];
  return sidecarOptionConsumesNextValue(previous) || sidecarUnknownRuntimeOptionValuePosition(command, index);
}

function sidecarOptionConsumesNextValue(value) {
  if (typeof value !== 'string' || !value.startsWith('-') || value.includes('=')) return false;
  return sidecarPreloadOptionConsumesNext(value) || SIDECAR_RUNTIME_VALUE_OPTIONS.has(value);
}

function sidecarUnknownRuntimeOptionValuePosition(command, index) {
  if (index < 2) return false;
  const previous = command[index - 1];
  if (typeof previous !== 'string' || !previous.startsWith('-') || previous.includes('=')) return false;
  if (sidecarPreloadOption(previous)) return false;
  if (SIDECAR_RUNTIME_FLAG_ONLY_OPTIONS.has(previous)) return false;
  if (sidecarOptionConsumesNextValue(previous)) return false;
  return sidecarCommandArtifact(command[index]);
}

function sidecarGenericOptionArtifact(value) {
  if (typeof value !== 'string' || !value.startsWith('-')) return null;
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  const candidate = value.slice(separator + 1);
  return sidecarCommandArtifact(candidate) ? candidate : null;
}

function sidecarPackageExecBeforeArtifact(command, index) {
  if (index < 1 || !SIDECAR_PACKAGE_MANAGER_SCRIPT_COMMANDS.has(String(command[index]).toLowerCase())) return false;
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(commandBaseName(command[0]).toLowerCase())) return false;
  for (let cursor = 1; cursor < index; cursor += 1) {
    if (sidecarCommandArtifact(command[cursor]) && !sidecarPackageManagerOptionValuePosition(command, cursor)) return false;
  }
  return true;
}

function sidecarPackageManagerOptionValuePosition(command, index) {
  if (index < 2 || !['bun', 'npm', 'pnpm', 'yarn'].includes(commandBaseName(command[0]).toLowerCase())) return false;
  const previous = command[index - 1];
  if (typeof previous !== 'string' || !previous.startsWith('-') || previous.includes('=')) return false;
  return SIDECAR_PACKAGE_MANAGER_VALUE_OPTIONS.has(previous);
}

function commandBaseName(value) {
  return String(value).split(/[\\/]/).at(-1);
}

function sidecarCommandArtifact(value) {
  if (typeof value !== 'string' || !value.length) return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('@') && !value.includes('/') && !sidecarArtifactPath(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (sidecarEnvAssignment(value) && !sidecarArtifactPath(value)) return false;
  return value.startsWith('./') || value.startsWith('../') || value.includes('/') || sidecarArtifactPath(value);
}

function sidecarEnvAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function sidecarArtifactPath(value) {
  return textArtifactPath(value) || /\.(?:wasm|bin|exe)$/i.test(value);
}

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') fail('ERR_CAPABILITY_ADAPTER_INVALID');
  const kind = adapter.kind ?? 'in_process';
  if (!['in_process', 'sidecar'].includes(kind)) fail('ERR_CAPABILITY_ADAPTER_INVALID', 'adapter kind must be in_process or sidecar');
  if (kind === 'in_process') {
    const module = optionalRelativePath(adapter.module, 'adapter.module');
    return Object.freeze({
      kind,
      module,
      exportName: requiredString(adapter.exportName, 'adapter.exportName'),
    });
  }
  if (!Array.isArray(adapter.command) || adapter.command.length === 0) {
    fail('ERR_CAPABILITY_ADAPTER_INVALID', 'sidecar adapter command must be a non-empty argv array');
  }
  return Object.freeze({
    kind,
    command: adapter.command.map((item) => optionalRelativePath(item, 'adapter.command')),
  });
}

function normalizeSecretDescriptors(value) {
  if (!Array.isArray(value)) fail('ERR_CAPABILITY_SECRET_DESCRIPTOR_INVALID');
  return value.map((item) => {
    if (typeof item === 'string') return Object.freeze({ name: item, class: 'opaque', required: true });
    requiredString(item?.name, 'secret.name');
    return Object.freeze({
      name: item.name,
      class: item.class == null ? 'opaque' : requiredString(item.class, 'secret.class'),
      required: item.required !== false,
      purpose: item.purpose == null ? null : requiredString(item.purpose, 'secret.purpose'),
    });
  });
}

function normalizePolicyRequirements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_CAPABILITY_POLICY_REQUIREMENTS_INVALID');
  return Object.freeze({
    allowLiveEffects: value.allowLiveEffects === true,
    allowNetworkEffects: value.allowNetworkEffects === true,
    allowFileEffects: value.allowFileEffects === true,
    allowHumanEffects: value.allowHumanEffects === true,
    allowBestEffort: value.allowBestEffort === true,
    allowedOrigins: requiredStringList(value.allowedOrigins ?? [], 'policyRequirements.allowedOrigins'),
    allowedMethods: requiredStringList(value.allowedMethods ?? [], 'policyRequirements.allowedMethods').map((item) => item.toUpperCase()),
    allowedFileRoots: requiredStringList(value.allowedFileRoots ?? [], 'policyRequirements.allowedFileRoots')
      .map((item) => optionalRelativePath(item, 'policyRequirements.allowedFileRoots')),
  });
}

function normalizeChecksums(value) {
  if (!Array.isArray(value)) fail('ERR_CAPABILITY_PACK_CHECKSUM_INVALID');
  return value.map((item) => Object.freeze({
    path: optionalRelativePath(item?.path, 'checksum.path'),
    checksum: requiredSha256(item?.checksum, 'checksum.checksum'),
  }));
}

function assertConformanceVector(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID');
  requiredString(value.name, 'vector.name');
  if (value.status !== 'passed') fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID', 'conformance vectors must pass');
  return Object.freeze({ ...value });
}

function assertNoCredentialMaterial(value, path = []) {
  if (value == null) return;
  if (typeof value === 'string') {
    const descriptorLabel = path[0] === 'requiredSecrets' && (path.length === 2 || ['name', 'class', 'purpose'].includes(path.at(-1)));
    const allowedSentinel = ['opaque', 'required', 'redacted'].includes(value);
    const credentialLike = SECRET_PATTERN.test(path.join('.')) || SECRET_PATTERN.test(value);
    if (
      (descriptorLabel && concreteSecretValue(value)) ||
      (!descriptorLabel && credentialLike && value.length > 0 && !allowedSentinel)
    ) {
      fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like value forbidden at ${path.join('.')}`);
    }
    if (/sk-[A-Za-z0-9_-]{8,}/.test(value)) fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `secret-looking value forbidden at ${path.join('.')}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, [...path, String(index)]));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertNoCredentialMaterial(child, [...path, key]);
  }
}

function assertNoMetadataCredentialMaterial(value) {
  if (value instanceof Uint8Array) {
    assertNoMetadataBytesCredentialMaterial(value);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (value.format !== 'base64' || typeof value.bytes !== 'string') return;
  let binary;
  try {
    binary = atob(value.bytes);
  } catch {
    return;
  }
  assertNoMetadataBytesCredentialMaterial(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function assertNoMetadataBytesCredentialMaterial(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  if (artifactCredentialText(text)) {
    fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', 'credential-like metadataBytes forbidden');
  }
}

function assertNoConformanceCredentialMaterial(value, path = []) {
  if (value == null) return;
  if (typeof value === 'string') {
    const credentialPath = SECRET_PATTERN.test(path.join('.'));
    const allowedSentinel = /^(?:opaque|required|redacted|no-(?:credentials?|secrets?|tokens?))$/i.test(value);
    if ((credentialPath && value.length > 0 && !allowedSentinel) || concreteSecretValue(value) || /sk-[A-Za-z0-9_-]{8,}/.test(value)) {
      fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like value forbidden at ${path.join('.')}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoConformanceCredentialMaterial(item, [...path, String(index)]));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertNoConformanceCredentialMaterial(child, [...path, key]);
  }
}

function concreteSecretValue(value) {
  return (
    /\b(?:bearer|basic)\s+\S+/i.test(value) ||
    /(?:^|[?&;,\s{])(?:credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key)\s*[:=]\s*\S+/i.test(value)
  );
}

function assertNoOperationLabelAuthority(manifest) {
  const bad = manifest.authorityLabels.filter((label) => /^operation:/i.test(label) || /^op:/i.test(label));
  if (bad.length) fail('ERR_CAPABILITY_OPERATION_LABEL_AUTHORITY_FORBIDDEN', 'operation-label dispatch is not authority', { labels: bad });
}

function packageName(value) {
  requiredString(value, 'packageName');
  if (!/^[a-z0-9@._/-]+$/i.test(value)) fail('ERR_CAPABILITY_PACKAGE_NAME_INVALID');
  return value;
}

function optionalRelativePath(value, field) {
  requiredString(value, field);
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    fail('ERR_CAPABILITY_HOST_PATH_FORBIDDEN', `${field} must be a relative artifact path`);
  }
  if (value.split(/[\\/]+/).includes('..')) fail('ERR_CAPABILITY_HOST_PATH_FORBIDDEN', `${field} must not escape the pack root`);
  return value;
}

function normalizeMetadataBytes(value) {
  if (value instanceof Uint8Array) return { format: 'base64', bytes: btoa(String.fromCharCode(...value)) };
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value;
  fail('ERR_CAPABILITY_METADATA_INVALID');
}

function exactInteger(value, field, expected) {
  if (value !== expected) fail('ERR_CAPABILITY_VERSION_UNSUPPORTED', `${field} must be ${expected}`);
  return value;
}

function exactString(value, field, expected) {
  if (value !== expected) fail('ERR_CAPABILITY_VERSION_UNSUPPORTED', `${field} must be ${expected}`);
  return value;
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be boolean`);
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} is required`);
  return value;
}

function requiredStringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be a string list`);
  }
  return [...value];
}

function requiredKnownResponseStatusList(value, field) {
  const list = requiredStringList(value, field);
  for (const item of list) {
    if (!RESPONSE_STATUSES.has(item)) fail('ERR_CAPABILITY_RESPONSE_STATUS_UNSUPPORTED', `${field} contains unsupported response status`);
  }
  return list;
}

function requiredPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be a positive safe integer`);
  return value;
}

function optionalFingerprint(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail('ERR_CAPABILITY_FINGERPRINT_INVALID', `${field} must be sha256 hex`);
  return value;
}

function requiredSha256(value, field) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail('ERR_CAPABILITY_PACK_CHECKSUM_INVALID', `${field} must be sha256 hex`);
  return value;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', assertBytes(bytes));
  return toHex(new Uint8Array(digest));
}
