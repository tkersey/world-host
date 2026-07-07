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
const HOST_NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource']);
const ADAPTER_IMPORT_SCANNERS = globalThis.Bun?.Transpiler ? Object.freeze({
  js: new globalThis.Bun.Transpiler({ loader: 'js' }),
  jsx: new globalThis.Bun.Transpiler({ loader: 'jsx' }),
  ts: new globalThis.Bun.Transpiler({ loader: 'ts' }),
  tsx: new globalThis.Bun.Transpiler({ loader: 'tsx' }),
}) : null;
const SIDECAR_RUNTIME_WRAPPERS = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'command',
  'csh',
  'dash',
  'env',
  'fish',
  'ionice',
  'ksh',
  'nice',
  'nohup',
  'powershell',
  'powershell.exe',
  'pwsh',
  'setsid',
  'sh',
  'stdbuf',
  'tcsh',
  'time',
  'timeout',
  'gtimeout',
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
const SIDECAR_MODULE_LOADER_OPTIONS = new Set([
  '--test-reporter',
]);
const SIDECAR_RUNTIME_FLAG_ONLY_OPTIONS = new Set([
  '--no-warnings',
  '--trace-warnings',
]);
const DENO_CONFIG_IMPORT_MAP_KEYS = new Set(['imports', 'importMap', 'scopes']);
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
  'explore',
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
const NODE_CONFIG_MODULE_OPTIONS = new Set([
  'experimental-loader',
  'experimentalLoader',
  'import',
  'loader',
  'require',
  'test-reporter',
  'testReporter',
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
  assertReferencedArtifactsCovered(manifest, artifacts);
  for (const item of manifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${item.path}`);
    assertNoArtifactCredentialMaterial(item.path, bytes);
    const actual = `sha256:${await sha256Hex(bytes)}`;
    if (actual !== item.checksum) fail('ERR_CAPABILITY_PACK_CHECKSUM_MISMATCH', `artifact checksum mismatch: ${item.path}`, { expected: item.checksum, actual });
  }
  assertSidecarDenoConfigsDoNotDefineImportMaps(manifest, artifacts);
  assertSidecarNodeConfigsDoNotLoadModules(manifest, artifacts);
  assertSidecarNodeEnvFilesDoNotLoadModules(manifest, artifacts);
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
  assertJavaScriptAdapterArtifactSelfContained(manifest.adapter.module, artifacts, 'adapter', checksumPathSet(manifest), new Set(), {
    ...adapterScannerOptionsForManifest(manifest),
    bunResolutionAliases: true,
    typeScriptCapableRuntime: true,
  });
}

function assertSidecarAdapterArtifactsSelfContained(manifest, artifacts) {
  if (manifest.adapter.kind !== 'sidecar') return;
  const covered = checksumPathSet(manifest);
  assertSidecarEntrypointScannable(manifest.adapter.command, artifacts);
  const shebangCommand = sidecarShebangRuntimeCommand(manifest.adapter.command, artifacts);
  const scannerOptions = {
    ...adapterScannerOptionsForManifest(manifest),
    bunResolutionAliases: sidecarUsesBunResolution(manifest.adapter.command, artifacts),
    typeScriptCapableRuntime: sidecarTypeScriptCapableRuntime(manifest.adapter.command) ||
      (shebangCommand ? sidecarTypeScriptCapableRuntime(shebangCommand) : false),
  };
  for (const artifactPath of sidecarScannedJavaScriptArtifacts(manifest.adapter.command, artifacts)) {
    if (!covered.has(artifactPath)) {
      fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${artifactPath}`);
    }
    assertJavaScriptAdapterArtifactSelfContained(artifactPath, artifacts, 'sidecar adapter', covered, new Set(), scannerOptions);
  }
}

function assertSidecarDenoConfigsDoNotDefineImportMaps(manifest, artifacts) {
  if (manifest.adapter.kind !== 'sidecar') return;
  const covered = checksumPathSet(manifest);
  const commands = [manifest.adapter.command];
  const shebangCommand = sidecarShebangRuntimeCommand(manifest.adapter.command, artifacts);
  if (shebangCommand) commands.push(shebangCommand);
  for (const command of commands) {
    for (const artifactPath of sidecarDenoConfigArtifacts(command)) {
      assertSidecarDenoConfigDoesNotDefineImportMaps(artifactPath, artifacts, covered, new Set());
    }
  }
}

function assertSidecarDenoConfigDoesNotDefineImportMaps(artifactPath, artifacts, covered, seen) {
  if (seen.has(artifactPath)) return;
  seen.add(artifactPath);
  const bytes = artifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  if (jsonLikeObjectHasTopLevelKey(text, DENO_CONFIG_IMPORT_MAP_KEYS)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Deno sidecar configs must not define import maps');
  }
  for (const extendsPath of jsonLikeObjectTopLevelStringValues(text, 'extends')) {
    const extendedArtifactPath = denoConfigExtendsArtifact(artifactPath, extendsPath, covered);
    assertSidecarDenoConfigDoesNotDefineImportMaps(extendedArtifactPath, artifacts, covered, seen);
  }
}

function assertSidecarNodeConfigsDoNotLoadModules(manifest, artifacts) {
  if (manifest.adapter.kind !== 'sidecar') return;
  const commands = [manifest.adapter.command];
  const shebangCommand = sidecarShebangRuntimeCommand(manifest.adapter.command, artifacts);
  if (shebangCommand) commands.push(shebangCommand);
  for (const command of commands) {
    for (const artifactPath of sidecarNodeConfigArtifacts(command)) {
      assertSidecarNodeConfigDoesNotLoadModules(artifactPath, artifacts);
    }
  }
}

function assertSidecarNodeConfigDoesNotLoadModules(artifactPath, artifacts) {
  const bytes = artifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return;
  let config;
  try {
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `Node sidecar config must be parseable JSON: ${artifactPath}`);
  }
  if (nodeConfigLoadsModules(config?.nodeOptions)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Node sidecar configs must not load modules outside checksum coverage');
  }
}

function assertSidecarNodeEnvFilesDoNotLoadModules(manifest, artifacts) {
  if (manifest.adapter.kind !== 'sidecar') return;
  const commands = [manifest.adapter.command];
  const shebangCommand = sidecarShebangRuntimeCommand(manifest.adapter.command, artifacts);
  if (shebangCommand) commands.push(shebangCommand);
  for (const command of commands) {
    for (const artifactPath of sidecarNodeEnvFileArtifacts(command)) {
      assertSidecarNodeEnvFileDoesNotLoadModules(artifactPath, artifacts);
    }
  }
}

function assertSidecarNodeEnvFileDoesNotLoadModules(artifactPath, artifacts) {
  const bytes = artifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `Node sidecar env file must be UTF-8 text: ${artifactPath}`);
  }
  if (nodeEnvFileSetsNodeOptions(text)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Node sidecar env files must not set NODE_OPTIONS');
  }
}

function nodeEnvFileSetsNodeOptions(text) {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const content = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    if (/^NODE_OPTIONS\s*=/.test(content)) return true;
  }
  return false;
}

function nodeConfigLoadsModules(nodeOptions) {
  if (nodeOptions == null || nodeOptions === false) return false;
  if (typeof nodeOptions === 'string') return nodeConfigOptionLoadsModule(nodeOptions);
  if (Array.isArray(nodeOptions)) return nodeOptions.some(nodeConfigLoadsModules);
  if (typeof nodeOptions !== 'object') return false;
  for (const [key, value] of Object.entries(nodeOptions)) {
    if (value == null || value === false) continue;
    if (NODE_CONFIG_MODULE_OPTIONS.has(key) || NODE_CONFIG_MODULE_OPTIONS.has(key.replace(/^--?/, ''))) return true;
  }
  return false;
}

function nodeConfigOptionLoadsModule(value) {
  if (typeof value !== 'string') return false;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const option = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    return sidecarPreloadOption(option) || sidecarRuntimeModuleLoaderOption(['node', option], 1);
  });
}

function checksumPathSet(manifest) {
  return new Set(manifest.checksums.map((item) => item.path));
}

function assertJavaScriptAdapterArtifactSelfContained(artifactPath, artifacts, label, covered, seen = new Set(), options = {}) {
  const bytes = artifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return;
  if (seen.has(artifactPath)) return;
  seen.add(artifactPath);
  const text = new TextDecoder().decode(bytes);
  const scannedText = stripJavaScriptShebang(text);
  const scannerOptions = options.typeScriptCapableRuntime || typeScriptCapableRuntimeShebang(text) || typeScriptArtifactPath(artifactPath)
    ? { ...options, typeScriptCapableRuntime: true }
    : options;
  const importScanner = adapterImportScanner(artifactPath, text, scannerOptions);
  if (!importScanner) fail('ERR_CAPABILITY_PACK_ADAPTER_IMPORT_SCAN_UNAVAILABLE', 'adapter import scanning requires Bun.Transpiler');
  let imports;
  try {
    imports = importScanner.scanImports(scannedText);
  } catch (error) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_IMPORT_SCAN_FAILED', `adapter import scan failed for ${artifactPath}`, { error: String(error?.message ?? error) });
  }
  if (adapterHasImportCall(scannedText)) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT', `${label} imports code outside its checksum-covered entry module: ${artifactPath}`);
  }
  const hostApiAccess = adapterHostApiAccess(scannedText, scannerOptions);
  if (hostApiAccess) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT', `${label} accesses host APIs outside receiver policy: ${artifactPath}`, { hostApi: hostApiAccess });
  }
  for (const item of imports) {
    const imported = localImportArtifact(artifactPath, item.path, covered, scannerOptions);
    if (!imported) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT', `${label} imports code outside its checksum-covered entry module: ${artifactPath}`);
    }
    if (!covered.has(imported)) {
      fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${imported}`);
    }
    if (!javascriptArtifactPath(imported)) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT', `${label} imports unscanned code outside its JavaScript artifact set: ${imported}`);
    }
    assertJavaScriptAdapterArtifactSelfContained(imported, artifacts, label, covered, seen, scannerOptions);
  }
}

function adapterScannerOptionsForManifest(manifest) {
  const authorityLabels = manifest?.authorityLabels ?? [];
  const actuationClasses = manifest?.supportedActuationClasses ?? [];
  return {
    allowHostFile: actuationClasses.includes('file') || authorityLabels.some((label) => label.startsWith('file:')),
    allowHostNetwork: actuationClasses.includes('http') || authorityLabels.some((label) => label.startsWith('network:')),
  };
}

function adapterHostApiAccess(text, options = {}) {
  const aliasAccess = adapterAliasesHostApiAccess(text, options);
  if (aliasAccess) return aliasAccess;
  for (let index = 0, previousSignificant = null; index < text.length;) {
    index = skipWhitespaceAndComments(text, index);
    if (index >= text.length) break;
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end;
      previousSignificant = 'literal';
      continue;
    }
    if (char === '`') {
      const literal = readTemplateString(text, index);
      const templateAccess = scanTemplateExpressions(literal, (expression) => adapterHostApiAccess(expression, options));
      if (templateAccess) return templateAccess;
      index = literal.end;
      previousSignificant = 'template';
      continue;
    }
    if (updateOperatorAt(text, index)) {
      const postfix = !regexLiteralCanStartAfter(previousSignificant);
      previousSignificant = postfix ? 'literal' : char;
      index += 2;
      continue;
    }
    if (numericLiteralStart(char)) {
      index = skipNumericLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (char === '/' && regexLiteralCanStartAfter(previousSignificant)) {
      index = skipRegexLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (!identifierStart(char) && !identifierEscapeStart(text, index)) {
      previousSignificant = char;
      index += 1;
      continue;
    }
    const identifierOffset = index;
    const identifierName = readIdentifierName(text, index);
    if (!identifierName || identifierName.invalid) return true;
    index = identifierName.end;
    const identifier = identifierName.value;
    const destructuredMember = destructuredHostGlobalAccess(text, identifierOffset, identifier, options);
    if (destructuredMember) return destructuredMember;
    const importMetaEnvAccess = importMetaEnvAccessAt(text, identifierOffset);
    if (importMetaEnvAccess) return importMetaEnvAccess;
    const member = directHostMemberAccess(text, index);
    if (member && unsafeHostGlobalMember(identifier, member.name, options)) return `${identifier}.${member.name}`;
    if (!member && previousSignificant !== '.' && unsafeBareHostGlobalValue(identifier, options)) return identifier;
    previousSignificant = identifierSignificance(identifier);
  }
  return null;
}

function directHostMemberAccess(text, index) {
  let cursor = skipWhitespaceAndComments(text, index);
  if (text[cursor] === '.') {
    cursor += 1;
  } else if (text[cursor] === '?' && text[cursor + 1] === '.') {
    cursor = skipWhitespaceAndComments(text, cursor + 2);
    if (text[cursor] === '[') return computedHostMemberAccess(text, cursor);
  } else if (text[cursor] === '[') {
    return computedHostMemberAccess(text, cursor);
  } else {
    return null;
  }
  cursor = skipWhitespaceAndComments(text, cursor);
  const member = readIdentifierName(text, cursor);
  return member && !member.invalid ? { name: member.value, end: member.end } : null;
}

function computedHostMemberAccess(text, openBracket) {
  const afterBracket = skipBalancedBracket(text, openBracket);
  const name = readComputedMemberName(text, openBracket + 1, afterBracket - 1);
  return name.static ? { name: name.value, end: afterBracket } : null;
}

function adapterAliasesHostApiAccess(text, options = {}) {
  const aliases = new Map();
  let previousSize;
  do {
    previousSize = aliases.size;
    scanAdapterAliasIdentifiers(text, (identifier, index, previousSignificant) => {
      const target = previousSignificant !== '.' ? hostAliasAssignmentAt(text, index, aliases) : null;
      if (target) aliases.set(identifier, target);
      return null;
    });
  } while (aliases.size !== previousSize);
  if (!aliases.size) return null;
  return scanAdapterAliasIdentifiers(text, (identifier, index, _previousSignificant, identifierOffset) => {
    const target = aliases.get(identifier);
    if (!target) return null;
    const destructuredMember = destructuredHostGlobalAccess(text, identifierOffset, target, options);
    if (destructuredMember) return destructuredMember;
    if (target === 'import.meta.env') return target;
    if (HOST_NETWORK_GLOBALS.has(target)) {
      return !options.allowHostNetwork ? target : null;
    }
    const member = directHostMemberAccess(text, index) ?? directHostMemberAccess(text, skipClosingCalleeParens(text, index));
    return member && unsafeHostGlobalMember(target, member.name, options) ? `${target}.${member.name}` : null;
  });
}

function scanAdapterAliasIdentifiers(text, visitor) {
  for (let index = 0, previousSignificant = null; index < text.length;) {
    index = skipWhitespaceAndComments(text, index);
    if (index >= text.length) break;
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end;
      previousSignificant = 'literal';
      continue;
    }
    if (char === '`') {
      const literal = readTemplateString(text, index);
      const result = scanTemplateExpressions(literal, (expression) => scanAdapterAliasIdentifiers(expression, visitor));
      if (result) return result;
      index = literal.end;
      previousSignificant = 'template';
      continue;
    }
    if (updateOperatorAt(text, index)) {
      const postfix = !regexLiteralCanStartAfter(previousSignificant);
      previousSignificant = postfix ? 'literal' : char;
      index += 2;
      continue;
    }
    if (numericLiteralStart(char)) {
      index = skipNumericLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (char === '/' && regexLiteralCanStartAfter(previousSignificant)) {
      index = skipRegexLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (!identifierStart(char) && !identifierEscapeStart(text, index)) {
      previousSignificant = char;
      index += 1;
      continue;
    }
    const identifierOffset = index;
    const identifierName = readIdentifierName(text, index);
    if (!identifierName || identifierName.invalid) return 'fetch';
    index = identifierName.end;
    const identifier = identifierName.value;
    const result = visitor(identifier, index, previousSignificant, identifierOffset);
    if (result) return result;
    previousSignificant = identifierSignificance(identifier);
  }
  return null;
}

function skipClosingCalleeParens(text, index) {
  let cursor = skipWhitespaceAndComments(text, index);
  while (text[cursor] === ')') cursor = skipWhitespaceAndComments(text, cursor + 1);
  return cursor;
}

function destructuredHostGlobalAccess(text, identifierStart, target, options = {}) {
  const assignmentIndex = destructuredHostAssignmentIndex(text, identifierStart);
  if (!hostValueAssignmentOperator(text, assignmentIndex)) return null;
  const patternEnd = skipWhitespaceBackward(text, assignmentIndex - 1);
  if (text[patternEnd] !== '}') return null;
  const patternStart = findMatchingOpenBraceBackward(text, patternEnd);
  if (patternStart < 0) return target;
  const member = unsafeDestructuredHostMember(text, patternStart + 1, patternEnd, target, options);
  return member ? `${target}.${member}` : null;
}

function destructuredHostAssignmentIndex(text, identifierStart) {
  let cursor = skipWhitespaceBackward(text, identifierStart - 1);
  while (text[cursor] === '(') cursor = skipWhitespaceBackward(text, cursor - 1);
  return cursor;
}

function hostValueAssignmentOperator(text, index) {
  if (text[index] !== '=') return false;
  if (text[index + 1] === '>' || text[index + 1] === '=') return false;
  return !['=', '!', '<', '>'].includes(text[index - 1]);
}

function skipWhitespaceBackward(text, index) {
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  return index;
}

function findMatchingOpenBraceBackward(text, closeBrace) {
  let depth = 0;
  for (let index = closeBrace; index >= 0; index -= 1) {
    if (text[index] === '}') {
      depth += 1;
      continue;
    }
    if (text[index] === '{') {
      depth -= 1;
      if (depth === 0) return index;
    }
    if (depth === 0 && text[index] === ';') break;
  }
  return -1;
}

function unsafeDestructuredHostMember(text, start, end, target, options = {}) {
  for (let index = start; index < end;) {
    index = skipWhitespaceAndComments(text, index);
    if (index >= end) break;
    const char = text[index];
    if (char === ',') {
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const literal = char === '`' ? readTemplateString(text, index) : readQuotedString(text, index, char);
      const afterLiteral = skipWhitespaceAndComments(text, literal.end);
      if (literal.value !== null && destructuredKeyFollower(text, afterLiteral, end) && unsafeHostGlobalMember(target, literal.value, options)) return literal.value;
      index = text[afterLiteral] === ':' ? skipDestructuredValue(text, afterLiteral + 1, end) : literal.end;
      continue;
    }
    if (char === '[') {
      const afterBracket = skipBalancedBracket(text, index);
      const name = readComputedMemberName(text, index + 1, afterBracket - 1);
      const afterName = skipWhitespaceAndComments(text, afterBracket);
      if (name.static && destructuredKeyFollower(text, afterName, end) && unsafeHostGlobalMember(target, name.value, options)) return name.value;
      index = text[afterName] === ':' ? skipDestructuredValue(text, afterName + 1, end) : afterBracket;
      continue;
    }
    if (!identifierStart(char) && !identifierEscapeStart(text, index)) {
      index += 1;
      continue;
    }
    const identifier = readIdentifierName(text, index);
    if (!identifier || identifier.invalid) return target;
    const afterIdentifier = skipWhitespaceAndComments(text, identifier.end);
    if (destructuredKeyFollower(text, afterIdentifier, end) && unsafeHostGlobalMember(target, identifier.value, options)) return identifier.value;
    index = text[afterIdentifier] === ':' || text[afterIdentifier] === '=' ? skipDestructuredValue(text, afterIdentifier + 1, end) : identifier.end;
  }
  return null;
}

function destructuredKeyFollower(text, index, end) {
  return index >= end || text[index] === ':' || text[index] === ',' || text[index] === '=';
}

function skipDestructuredValue(text, index, end) {
  while (index < end) {
    index = skipWhitespaceAndComments(text, index);
    if (index >= end || text[index] === ',') return index + 1;
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end;
      continue;
    }
    if (char === '`') {
      index = readTemplateString(text, index).end;
      continue;
    }
    if (char === '{') {
      index = skipBalancedBrace(text, index);
      continue;
    }
    if (char === '[') {
      index = skipBalancedBracket(text, index);
      continue;
    }
    if (char === '(') {
      index = skipBalancedParentheses(text, index);
      continue;
    }
    index += 1;
  }
  return index;
}

function hostAliasAssignmentAt(text, index, aliases) {
  const assignmentEnd = fetchAliasAssignmentEnd(text, skipWhitespaceAndComments(text, index));
  if (assignmentEnd < 0) return null;
  return hostAliasAssignmentValueAt(text, assignmentEnd, aliases);
}

function hostAliasAssignmentValueAt(text, index, aliases) {
  let value = skipWhitespaceAndComments(text, index);
  while (true) {
    const prefix = readIdentifierName(text, value);
    if (!prefix || prefix.invalid || prefix.value !== 'await') break;
    value = skipWhitespaceAndComments(text, prefix.end);
  }
  const importMetaTarget = importMetaAliasTargetAt(text, value);
  if (importMetaTarget) return importMetaTarget;
  const identifier = readIdentifierName(text, value);
  if (identifier) return !identifier.invalid ? hostAliasTarget(identifier.value, aliases) : 'fetch';
  if (text[value] === '(') {
    const end = skipBalancedParentheses(text, value);
    return hostAliasTargetInSpan(text, value + 1, end - 1, aliases);
  }
  return null;
}

function fetchAliasAssignmentEnd(text, index) {
  if (text[index] === '=' && text[index + 1] !== '=' && text[index + 1] !== '>') return index + 1;
  if (text[index + 2] === '=' && (
    (text[index] === '|' && text[index + 1] === '|') ||
    (text[index] === '&' && text[index + 1] === '&') ||
    (text[index] === '?' && text[index + 1] === '?')
  )) return index + 3;
  return -1;
}

function hostAliasTarget(identifier, aliases) {
  if (HOST_NETWORK_GLOBALS.has(identifier) || identifier === 'process' || identifier === 'Bun' || ['globalThis', 'global', 'window', 'self'].includes(identifier)) return identifier;
  return aliases.get(identifier) ?? null;
}

function hostAliasTargetInSpan(text, start, end, aliases) {
  for (let index = start, previousSignificant = null; index <= end;) {
    index = skipWhitespaceAndComments(text, index);
    if (index > end) break;
    const char = text[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end;
      previousSignificant = 'literal';
      continue;
    }
    if (char === '`') {
      const literal = readTemplateString(text, index);
      const target = scanTemplateExpressions(literal, (expression) => hostAliasTargetInSpan(expression, 0, expression.length - 1, aliases));
      if (target) return target;
      index = literal.end;
      previousSignificant = 'template';
      continue;
    }
    if (updateOperatorAt(text, index)) {
      const postfix = !regexLiteralCanStartAfter(previousSignificant);
      previousSignificant = postfix ? 'literal' : char;
      index += 2;
      continue;
    }
    if (numericLiteralStart(char)) {
      index = skipNumericLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (char === '/' && regexLiteralCanStartAfter(previousSignificant)) {
      index = skipRegexLiteral(text, index);
      previousSignificant = 'literal';
      continue;
    }
    if (!identifierStart(char) && !identifierEscapeStart(text, index)) {
      previousSignificant = char;
      index += 1;
      continue;
    }
    const importMetaTarget = importMetaAliasTargetAt(text, index);
    if (importMetaTarget) return importMetaTarget;
    const identifier = readIdentifierName(text, index);
    if (!identifier || identifier.invalid) return 'fetch';
    const target = hostAliasTarget(identifier.value, aliases);
    if (target) return target;
    index = identifier.end;
    previousSignificant = identifierSignificance(identifier.value);
  }
  return null;
}

function importMetaEnvAccessAt(text, index) {
  return importMetaAliasTargetAt(text, index) === 'import.meta.env' ? 'import.meta.env' : null;
}

function importMetaAliasTargetAt(text, index) {
  const identifier = readIdentifierName(text, index);
  if (!identifier || identifier.invalid || identifier.value !== 'import') return null;
  const metaMember = directHostMemberAccess(text, identifier.end);
  if (!metaMember || metaMember.name !== 'meta') return null;
  const envMember = directHostMemberAccess(text, metaMember.end);
  return envMember?.name === 'env' ? 'import.meta.env' : 'import.meta';
}

function identifierSignificance(identifier) {
  return ['return', 'throw', 'case', 'yield', 'await', 'typeof', 'void', 'delete'].includes(identifier) ? identifier : 'identifier';
}

function updateOperatorAt(text, index) {
  return (text[index] === '+' || text[index] === '-') && text[index + 1] === text[index];
}

function regexLiteralCanStartAfter(previousSignificant) {
  return previousSignificant == null || !['identifier', 'literal', 'template', ')', ']', '}'].includes(previousSignificant);
}

function numericLiteralStart(char) {
  return typeof char === 'string' && /^[0-9]$/.test(char);
}

function skipNumericLiteral(text, index) {
  index += 1;
  let previous = text[index - 1];
  while (index < text.length) {
    const char = text[index];
    if (/[_0-9.]/.test(char) || /[A-Fa-fBbEeNnOoXx]/.test(char) || ((char === '+' || char === '-') && (previous === 'e' || previous === 'E'))) {
      previous = char;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function skipRegexLiteral(text, index) {
  index += 1;
  let inCharacterClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n' || char === '\r') return index;
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      index += 1;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (char === '/') {
      index += 1;
      while (identifierPart(text[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

function unsafeHostGlobalMember(identifier, member, options = {}) {
  if (identifier === 'import.meta') return member === 'env';
  if (identifier === 'import.meta.env') return true;
  if (['globalThis', 'global', 'window', 'self'].includes(identifier)) {
    if (['process', 'Bun'].includes(member)) return true;
    if (['fetch', 'WebSocket', 'EventSource'].includes(member)) return !options.allowHostNetwork;
    return ['Worker', 'SharedWorker'].includes(member);
  }
  if (identifier === 'Bun') {
    if (['connect', 'fetch', 'listen', 'redis', 's3', 'serve', 'sql', 'udpSocket'].includes(member)) return !options.allowHostNetwork;
    if (['build', 'file', 'Glob', 'mmap', 'resolve', 'resolveSync', 'write'].includes(member)) return !options.allowHostFile;
    return ['$', 'env', 'FFI', 'password', 'spawn', 'spawnSync'].includes(member);
  }
  if (identifier === 'process') {
    return ['abort', 'binding', 'chdir', 'cwd', 'dlopen', 'env', 'exit', 'kill', 'report'].includes(member);
  }
  return false;
}

function unsafeBareHostGlobalValue(identifier, options = {}) {
  if (HOST_NETWORK_GLOBALS.has(identifier)) return !options.allowHostNetwork;
  return identifier === 'process' || identifier === 'Bun' || ['globalThis', 'global', 'window', 'self'].includes(identifier);
}

function stripJavaScriptShebang(text) {
  return text.startsWith('#!') ? text.replace(/^#![^\r\n]*(?:\r\n|\n|\r)?/, '') : text;
}

function assertNoArtifactCredentialMaterial(artifactPath, bytes) {
  if (!textArtifactPath(artifactPath) && !extensionlessArtifactPath(artifactPath)) return;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return;
  }
  if (artifactCredentialText(text)) fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like artifact content forbidden at ${artifactPath}`);
}

function textArtifactPath(artifactPath) {
  return /\.(?:c?m?js|[cm]?ts|tsx|jsx|jsonc?|md|txt|ya?ml|toml|ini|conf|cfg|env|pem|crt|cer|key|sh|bash|zsh|fish|py|rb|pl)$/i.test(artifactPath) ||
    /(?:^|[/\\])\.env(?:\.[A-Za-z0-9._-]+)?$/i.test(artifactPath);
}

function javascriptArtifactPath(artifactPath) {
  return explicitJavaScriptArtifactPath(artifactPath) || extensionlessArtifactPath(artifactPath);
}

function explicitJavaScriptArtifactPath(artifactPath) {
  return /\.(?:c?m?js|[cm]?ts|tsx|jsx)$/i.test(artifactPath);
}

function typeScriptArtifactPath(artifactPath) {
  return /\.(?:[cm]?ts|tsx)$/i.test(artifactPath);
}

function adapterImportScanner(artifactPath, text = '', options = {}) {
  if (!ADAPTER_IMPORT_SCANNERS) return null;
  if (/\.tsx$/i.test(artifactPath)) return ADAPTER_IMPORT_SCANNERS.tsx;
  if (/\.[cm]?ts$/i.test(artifactPath)) return ADAPTER_IMPORT_SCANNERS.ts;
  if (/\.jsx$/i.test(artifactPath)) return ADAPTER_IMPORT_SCANNERS.jsx;
  if (extensionlessArtifactPath(artifactPath) && (options.typeScriptCapableRuntime || typeScriptCapableRuntimeShebang(text))) return ADAPTER_IMPORT_SCANNERS.ts;
  return ADAPTER_IMPORT_SCANNERS.js;
}

function typeScriptCapableRuntimeShebang(text) {
  if (typeof text !== 'string' || !text.startsWith('#!')) return false;
  const lineEnd = text.search(/\r|\n/);
  const firstLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  return /(?:^|[/\s])(?:bun|deno)(?:\s|$)/i.test(firstLine);
}

function extensionlessArtifactPath(artifactPath) {
  return !/[.][^/\\.]+$/.test(commandBaseName(artifactPath));
}

function localImportArtifact(fromPath, specifier, covered, options = {}) {
  if (typeof specifier !== 'string' || (!specifier.startsWith('./') && !specifier.startsWith('../'))) return null;
  if (specifier.endsWith('/') || specifier.endsWith('\\')) return null;
  const canonicalSpecifier = canonicalLocalImportSpecifier(specifier);
  if (!canonicalSpecifier) return null;
  const candidates = localImportArtifactCandidates(fromPath, canonicalSpecifier, options);
  return candidates.find((candidate) => covered.has(candidate)) ?? candidates[0] ?? null;
}

function canonicalLocalImportSpecifier(specifier) {
  if (!/%[0-9a-fA-F]{2}/.test(specifier)) return specifier;
  try {
    const decoded = decodeURIComponent(specifier);
    return decoded.startsWith('./') || decoded.startsWith('../') ? decoded : null;
  } catch {
    return null;
  }
}

function localImportArtifactCandidates(fromPath, specifier, options = {}) {
  const normalizedFrom = normalizeArtifactPath(fromPath);
  const base = normalizedFrom.includes('/') ? normalizedFrom.slice(0, normalizedFrom.lastIndexOf('/')) : '';
  const resolved = normalizeArtifactPath(base ? `${base}/${specifier}` : specifier);
  if (!resolved) return [];
  const aliases = [resolved];
  if (!resolved.startsWith('./')) {
    aliases.push(`./${resolved}`);
  }
  if (!base && specifier.startsWith('./')) {
    aliases.push(specifier);
  }
  if (fromPath.startsWith('./')) {
    aliases.push(`./${resolved}`);
  }
  return interleavedLocalImportCandidates(aliases, normalizedFrom, options);
}

function extensionedLocalImportCandidates(value, fromPath, options = {}) {
  if (!options.bunResolutionAliases) return [value];
  const typeScriptAliases = typeScriptExplicitJavaScriptImportCandidates(value, fromPath);
  if (typeScriptAliases) return typeScriptAliases;
  if (!extensionlessArtifactPath(value)) return [value];
  return [
    value,
    `${value}.tsx`,
    `${value}.jsx`,
    `${value}.mts`,
    `${value}.ts`,
    `${value}.mjs`,
    `${value}.js`,
    `${value}.cts`,
    `${value}.cjs`,
  ];
}

function typeScriptExplicitJavaScriptImportCandidates(value, fromPath) {
  if (!typeScriptArtifactPath(fromPath)) return null;
  if (/\.js$/i.test(value)) return [value, value.replace(/\.js$/i, '.ts'), value.replace(/\.js$/i, '.tsx'), value.replace(/\.js$/i, '.mts')];
  if (/\.jsx$/i.test(value)) return [value, value.replace(/\.jsx$/i, '.tsx')];
  if (/\.mjs$/i.test(value)) return [value, value.replace(/\.mjs$/i, '.mts')];
  return null;
}

function interleavedLocalImportCandidates(values, fromPath, options = {}) {
  const groups = [...new Set(values)].map((value) => extensionedLocalImportCandidates(value, fromPath, options));
  const candidates = [];
  const width = Math.max(...groups.map((group) => group.length));
  for (let index = 0; index < width; index += 1) {
    for (const group of groups) {
      if (group[index]) candidates.push(group[index]);
    }
  }
  return [...new Set(candidates)];
}

function normalizeArtifactPath(value) {
  const parts = [];
  for (const part of String(value).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function artifactCredentialText(text) {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text)) return true;
  if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) return true;
  const scheme = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/-]{8,}={0,2})/ig;
  for (const match of text.matchAll(scheme)) {
    if (!artifactCredentialSentinel(match[1])) return true;
  }
  const quotedAssignment = /(?:^|[?&;,\s{])["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(["'])([A-Za-z0-9._~+/-]{8,}={0,2})\2/ig;
  for (const match of text.matchAll(quotedAssignment)) {
    if (SECRET_PATTERN.test(match[1]) && !artifactCredentialSentinel(match[3])) return true;
  }
  const envAssignment = /(?:^|\r?\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([A-Za-z0-9._~+/-]{8,}={0,2})\s*(?:#.*)?(?=\r?\n|$)/ig;
  for (const match of text.matchAll(envAssignment)) {
    if (SECRET_PATTERN.test(match[1]) && !artifactCredentialSentinel(match[2])) return true;
  }
  return false;
}

function artifactCredentialSentinel(value) {
  return /^(?:redacted|opaque|required|none|null|example(?:[-_].*)?|fixture(?:[-_].*)?|no-(?:credentials?|secrets?|tokens?))$/i.test(value);
}

function adapterHasImportCall(text) {
  if (adapterAliasesGlobalObject(text)) return true;
  if (adapterAliasesReflectiveGetter(text)) return true;
  if (adapterAliasesDangerousComputedMember(text)) return true;
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
      if (scanTemplateExpressions(literal, adapterHasImportCall)) return true;
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
    if (!identifierStart(char) && !identifierEscapeStart(text, index)) {
      previousSignificant = char;
      index += 1;
      continue;
    }
    const identifierName = readIdentifierName(text, index);
    if (!identifierName || identifierName.invalid) return true;
    index = identifierName.end;
    const identifier = identifierName.value;
    const callStart = skipWhitespaceAndComments(text, index);
    if (identifier === 'Reflect' && reflectiveGetterAccess(text, callStart)) return true;
    if (identifier === 'eval' || identifier === 'Function' || identifier === 'getBuiltinModule' || identifier === 'getOwnPropertyDescriptor' ||
      identifier === 'Worker' || identifier === 'SharedWorker') {
      return true;
    }
    if (identifier === 'constructor' && previousSignificant === '.') return true;
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
    if (!staticImportCallLiteral(text, callStart, callEnd)) return true;
    previousSignificant = 'identifier';
    index = callEnd;
  }
  return false;
}

function staticImportCallLiteral(text, callStart, callEnd) {
  let index = skipWhitespaceAndComments(text, callStart + 1);
  const quote = text[index];
  if (quote !== '\'' && quote !== '"' && quote !== '`') return false;
  const literal = quote === '`' ? readTemplateString(text, index) : readQuotedString(text, index, quote);
  if (literal.value === null) return false;
  index = skipWhitespaceAndComments(text, literal.end);
  return text[index] === ')' && index + 1 === callEnd;
}

function adapterAliasesGlobalObject(text) {
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
  const globalObject = '(?:globalThis|global|window|self)';
  return new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*${globalObject}\\b`).test(text) ||
    new RegExp(`(?:^|[;{}(),\\n])\\s*${identifier}\\s*=\\s*${globalObject}\\b`).test(text);
}

function adapterAliasesReflectiveGetter(text) {
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
  const reflectAliases = new Set(['Reflect']);
  const aliasDeclaration = new RegExp(`\\b(?:const|let|var)\\s+(${identifier})\\s*=\\s*(${identifier})\\b`, 'g');
  for (let changed = true; changed;) {
    changed = false;
    aliasDeclaration.lastIndex = 0;
    for (const match of text.matchAll(aliasDeclaration)) {
      if (reflectAliases.has(match[2]) && !reflectAliases.has(match[1])) {
        reflectAliases.add(match[1]);
        changed = true;
      }
    }
  }
  const reflectAliasPattern = [...reflectAliases].join('|');
  const getterAccess = `(?:\\.\\s*get|\\[\\s*(["'\`])get\\1\\s*\\])`;
  const getterDeclaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*(?:${reflectAliasPattern})\\s*${getterAccess}`);
  const getterUse = new RegExp(`\\b(?:${reflectAliasPattern})\\s*${getterAccess}`);
  return getterDeclaration.test(text) || getterUse.test(text);
}

function adapterAliasesDangerousComputedMember(text) {
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';
  const literalAliases = new Set();
  const literalDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(["'`])([^"'`]+)\2/g;
  for (const match of text.matchAll(literalDeclaration)) {
    if (dangerousMemberName(match[3])) literalAliases.add(match[1]);
  }
  const aliasDeclaration = new RegExp(`\\b(?:const|let|var)\\s+(${identifier})\\s*=\\s*(${identifier})\\b`, 'g');
  for (let changed = true; changed;) {
    changed = false;
    aliasDeclaration.lastIndex = 0;
    for (const match of text.matchAll(aliasDeclaration)) {
      if (literalAliases.has(match[2]) && !literalAliases.has(match[1])) {
        literalAliases.add(match[1]);
        changed = true;
      }
    }
  }
  if (!literalAliases.size) return false;
  const aliasPattern = [...literalAliases].map(escapeRegExp).join('|');
  const dangerousReceiver = '(?:process|globalThis|global|window|self)';
  const computedDangerousMember = `${dangerousReceiver}\\s*(?:\\?\\.)?\\[\\s*(?:${aliasPattern})\\s*\\]`;
  const directCall = new RegExp(`\\b${computedDangerousMember}\\s*(?:\\?\\.\\s*)?\\(`);
  if (directCall.test(text)) return true;
  const calleeAliases = new Set();
  const memberDeclaration = new RegExp(`\\b(?:const|let|var)\\s+(${identifier})\\s*=\\s*${computedDangerousMember}`, 'g');
  for (const match of text.matchAll(memberDeclaration)) calleeAliases.add(match[1]);
  const memberAssignment = new RegExp(`(?:^|[;{}(),\\n])\\s*(${identifier})\\s*=\\s*${computedDangerousMember}`, 'g');
  for (const match of text.matchAll(memberAssignment)) calleeAliases.add(match[1]);
  for (const alias of calleeAliases) {
    const call = new RegExp(`\\b${escapeRegExp(alias)}\\s*(?:\\?\\.\\s*)?\\(`);
    if (call.test(text)) return true;
  }
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function dangerousCallAt(text, index) {
  if (text[index] === '(') return true;
  if (text[index] !== '?' || text[index + 1] !== '.') return false;
  return text[skipWhitespaceAndComments(text, index + 2)] === '(';
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
    value === 'getBuiltinModule' || value === 'getOwnPropertyDescriptor' || value === 'Worker' || value === 'SharedWorker';
}

function reflectiveGetterAccess(text, index) {
  index = skipWhitespaceAndComments(text, index);
  if (text[index] === '.') {
    index = skipWhitespaceAndComments(text, index + 1);
    const identifier = readIdentifierName(text, index);
    if (!identifier || identifier.invalid) return true;
    return identifier.value === 'get';
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
  if (text[index] === ')') {
    const openParenthesis = matchingOpenParenthesisBackward(text, index);
    if (openParenthesis < 0) return false;
    return globalReceiverExpressionSpan(text, openParenthesis + 1, index - 1);
  }
  if (index < 0 || !identifierPart(text[index])) return false;
  const end = index + 1;
  while (index >= 0 && identifierPart(text[index])) index -= 1;
  return globalReceiverExpressionSpan(text, index + 1, end - 1);
}

function globalReceiverExpressionSpan(text, start, end) {
  start = skipWhitespaceAndComments(text, start);
  end = skipWhitespaceAndCommentsBackward(text, end);
  if (start > end) return false;
  if (text[start] === '(' && text[end] === ')') {
    const closeParenthesis = skipBalancedParentheses(text, start);
    if (closeParenthesis === end + 1) return globalReceiverExpressionSpan(text, start + 1, end - 1);
  }
  const comma = lastTopLevelComma(text, start, end);
  if (comma >= 0) return globalReceiverExpressionSpan(text, comma + 1, end);
  const name = readIdentifierName(text, start);
  if (!name || name.invalid) return false;
  let index = name.end;
  if (skipWhitespaceAndComments(text, index) <= end) return false;
  const identifier = name.value;
  return identifier === 'globalThis' || identifier === 'global' || identifier === 'window' || identifier === 'self' || identifier === 'process';
}

function lastTopLevelComma(text, start, end) {
  let comma = -1;
  for (let index = start; index <= end;) {
    index = skipWhitespaceAndComments(text, index);
    const char = text[index];
    if (char === '\'' || char === '"' || char === '`') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '(') {
      index = skipBalancedParentheses(text, index);
      continue;
    }
    if (char === '[') {
      index = skipBalancedBracket(text, index);
      continue;
    }
    if (char === '{') {
      index = skipBalancedBrace(text, index);
      continue;
    }
    if (char === ',') comma = index;
    index += 1;
  }
  return comma;
}

function matchingOpenParenthesisBackward(text, closeParenthesis) {
  let depth = 0;
  for (let index = closeParenthesis; index >= 0; index -= 1) {
    if (text[index] === ')') depth += 1;
    if (text[index] === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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

function jsonLikeObjectHasTopLevelKey(text, keys) {
  let depth = 0;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === '"') {
      const literal = readQuotedString(text, index, char);
      const next = skipWhitespaceAndComments(text, literal.end);
      if (depth === 1 && text[next] === ':' && keys.has(literal.value)) return true;
      index = literal.end;
      continue;
    }
    if (char === '\'') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth <= 0) return false;
      index += 1;
      continue;
    }
    if (char === '[') {
      index = skipBalancedBracket(text, index);
      continue;
    }
    index += 1;
  }
  return false;
}

function jsonLikeObjectTopLevelStringValues(text, keyName) {
  const entries = [];
  let depth = 0;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === '"') {
      const literal = readQuotedString(text, index, char);
      const next = skipWhitespaceAndComments(text, literal.end);
      if (depth === 1 && text[next] === ':' && literal.value === keyName) {
        const value = jsonLikeStringValueSpan(text, next + 1);
        entries.push(...value.entries);
        index = Math.max(index + 1, value.end);
        continue;
      }
      index = literal.end;
      continue;
    }
    if (char === '\'') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth <= 0) return entries;
      index += 1;
      continue;
    }
    if (char === '[') {
      index = skipBalancedBracket(text, index);
      continue;
    }
    index += 1;
  }
  return entries;
}

function jsonLikeStringValueSpan(text, index) {
  index = skipWhitespaceAndComments(text, index);
  if (text[index] === '"') {
    const literal = readQuotedString(text, index, text[index]);
    return { entries: literal.value === null ? [] : [literal.value], end: literal.end };
  }
  if (text[index] === '[') return jsonLikeArrayStringSpan(text, index);
  return { entries: [], end: skipJsonLikeValue(text, index) };
}

function jsonLikeArrayStringSpan(text, index) {
  const entries = [];
  let depth = 0;
  while (index < text.length) {
    const skipped = skipWhitespaceAndComments(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === '"') {
      const literal = readQuotedString(text, index, char);
      const next = skipWhitespaceAndComments(text, literal.end);
      if (depth === 1 && (text[next] === ',' || text[next] === ']') && literal.value !== null) entries.push(literal.value);
      index = literal.end;
      continue;
    }
    if (char === '\'') {
      index = skipQuotedString(text, index, char);
      continue;
    }
    if (char === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      index += 1;
      if (depth <= 0) return { entries, end: index };
      continue;
    }
    index += 1;
  }
  return { entries, end: index };
}

function skipJsonLikeValue(text, index) {
  index = skipWhitespaceAndComments(text, index);
  if (text[index] === '"') return readQuotedString(text, index, text[index]).end;
  if (text[index] === '\'') return skipQuotedString(text, index, text[index]);
  if (text[index] === '[') return skipBalancedBracket(text, index);
  if (text[index] === '{') return skipBalancedBrace(text, index);
  while (index < text.length && text[index] !== ',' && text[index] !== '}') index += 1;
  return index;
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
  const expressions = [];
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
      const expressionStart = index + 2;
      const expressionEnd = skipBalancedBrace(text, index + 1);
      const closeBrace = text[expressionEnd - 1] === '}' ? expressionEnd - 1 : expressionEnd;
      expressions.push(text.slice(expressionStart, Math.max(expressionStart, closeBrace)));
      index = expressionEnd;
      continue;
    }
    if (text[index] === '`') return { value: staticLiteral ? value : null, end: index + 1, expressions };
    if (staticLiteral) value += text[index];
    index += 1;
  }
  return { value: staticLiteral ? value : null, end: index, expressions };
}

function scanTemplateExpressions(literal, scanner) {
  for (const expression of literal.expressions ?? []) {
    const result = scanner(expression);
    if (result) return result;
  }
  return null;
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
  return typeof char === 'string' && char.length === 1 && /[A-Za-z_$]/.test(char);
}

function identifierPart(char) {
  return typeof char === 'string' && char.length === 1 && /[A-Za-z0-9_$]/.test(char);
}

function identifierEscapeStart(text, index) {
  return text[index] === '\\' && text[index + 1] === 'u';
}

function readIdentifierName(text, index) {
  let value = '';
  let cursor = index;
  let first = true;
  for (;;) {
    if (cursor >= text.length) break;
    let part = null;
    let end = cursor + 1;
    if (identifierEscapeStart(text, cursor)) {
      const escaped = readIdentifierEscape(text, cursor);
      if (!escaped.value) return { value, end: escaped.end, invalid: true };
      part = escaped.value;
      end = escaped.end;
    } else {
      part = text[cursor];
    }
    if (first ? !identifierStart(part) : !identifierPart(part)) break;
    value += part;
    cursor = end;
    first = false;
  }
  return first ? null : { value, end: cursor, invalid: false };
}

function readIdentifierEscape(text, index) {
  if (!identifierEscapeStart(text, index)) return { value: null, end: index + 1 };
  if (text[index + 2] === '{') {
    const close = text.indexOf('}', index + 3);
    if (close !== -1) return { value: stringEscapeCodePoint(text.slice(index + 3, close)), end: close + 1 };
    return { value: null, end: text.length };
  }
  return { value: stringEscapeCodePoint(text.slice(index + 2, index + 6)), end: Math.min(index + 6, text.length) };
}

function assertReferencedArtifactsCovered(manifest, artifacts) {
  const covered = new Set(manifest.checksums.map((item) => item.path));
  const required = new Set([
    ...manifest.docs,
    ...(manifest.conformanceCorpusFingerprint ? ['conformance.json'] : []),
  ]);
  if (manifest.adapter.kind === 'in_process' && manifest.adapter.module) required.add(manifest.adapter.module);
  if (manifest.adapter.kind === 'sidecar') {
    for (const artifactPath of sidecarCommandArtifacts(manifest.adapter.command, artifacts)) required.add(artifactPath);
  }
  for (const path of required) {
    if (!covered.has(path)) fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${path}`);
  }
}

function sidecarCommandArtifacts(command, packArtifacts = null) {
  const artifacts = [];
  let entrypointSeen = false;
  assertDenoConfigIsolated(command);
  for (let index = 0; index < command.length; index += 1) {
    const value = command[index];
    assertSafeSidecarCommandToken(command, index);
    const genericOptionArtifact = sidecarGenericOptionArtifact(value);
    if (genericOptionArtifact && !sidecarRuntimeOptionPosition(command, index)) {
      artifacts.push(genericOptionArtifact);
      continue;
    }
    if (sidecarRuntimeOptionPosition(command, index)) {
      if (!entrypointSeen && commandBaseName(command[0]).toLowerCase() === 'bun') {
        const bunConfigArtifact = sidecarBunConfigOptionArtifact(value, command[index + 1]);
        if (bunConfigArtifact) {
          if (!sidecarCommandArtifact(bunConfigArtifact)) {
            fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar runtime option must reference a pack-relative checksum-covered artifact: ${value}`);
          }
          artifacts.push(bunConfigArtifact);
          if (sidecarBunConfigOptionConsumesNext(value)) index += 1;
          continue;
        }
      }
      if (!entrypointSeen && commandBaseName(command[0]).toLowerCase() === 'deno') {
        const denoConfigArtifact = sidecarDenoConfigOptionArtifact(value, command[index + 1]);
        if (denoConfigArtifact) {
          if (!sidecarCommandArtifact(denoConfigArtifact)) {
            fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar runtime option must reference a pack-relative checksum-covered artifact: ${value}`);
          }
          artifacts.push(denoConfigArtifact);
          if (sidecarDenoConfigOptionConsumesNext(value)) index += 1;
          continue;
        }
      }
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
        if (sidecarOptionValueArtifact(value, candidate)) {
          artifacts.push(candidate);
          index += 1;
          continue;
        }
        fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar runtime option must reference a pack-relative checksum-covered artifact: ${value}`);
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
  const shebangCommand = packArtifacts ? sidecarShebangRuntimeCommand(command, packArtifacts) : null;
  if (shebangCommand) artifacts.push(...sidecarCommandArtifacts(shebangCommand));
  return [...new Set(artifacts)];
}

function sidecarScannedJavaScriptArtifacts(command, packArtifacts) {
  const artifacts = new Set();
  const runtimeEntrypoint = sidecarRuntimeEntrypointArtifact(command);
  if (runtimeEntrypoint) artifacts.add(runtimeEntrypoint);
  const commandEntrypoint = sidecarCommandEntrypointArtifact(command);
  if (commandEntrypoint && sidecarCommandEntrypointNeedsJavaScriptScan(commandEntrypoint, packArtifacts, {
    allowScannableExtensionless: sidecarRuntimeCommandPosition(command, 0),
  })) {
    artifacts.add(commandEntrypoint);
  }
  for (const artifactPath of sidecarPreloadArtifacts(command)) artifacts.add(artifactPath);
  for (const artifactPath of sidecarBunConfigPreloadArtifacts(command, packArtifacts)) artifacts.add(artifactPath);
  const shebangCommand = sidecarShebangRuntimeCommand(command, packArtifacts);
  if (shebangCommand) {
    for (const artifactPath of sidecarPreloadArtifacts(shebangCommand)) artifacts.add(artifactPath);
    for (const artifactPath of sidecarBunConfigPreloadArtifacts(shebangCommand, packArtifacts)) artifacts.add(artifactPath);
  }
  for (const artifactPath of sidecarCommandArtifacts(command, packArtifacts)) {
    if (explicitJavaScriptArtifactPath(artifactPath) && !runtimeOptionDataArtifact(artifactPath)) artifacts.add(artifactPath);
  }
  return artifacts;
}

function assertSidecarEntrypointScannable(command, packArtifacts) {
  const entrypoint = sidecarSelectedEntrypointArtifact(command);
  if (!entrypoint) return;
  if (!sidecarRuntimeCommandPosition(command, 0) && sidecarCommandEntrypointArtifact(command) !== entrypoint) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar adapter entrypoints must be invoked directly or by a JavaScript runtime');
  }
  if (sidecarCommandEntrypointNeedsJavaScriptScan(entrypoint, packArtifacts, {
    allowScannableExtensionless: sidecarRuntimeCommandPosition(command, 0),
  })) return;
  fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar adapter entrypoints must be JavaScript or carry a JavaScript runtime shebang');
}

function sidecarSelectedEntrypointArtifact(command) {
  const commandEntrypoint = sidecarCommandEntrypointArtifact(command);
  if (commandEntrypoint) return commandEntrypoint;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 ? null : command[entrypointIndex];
}

function sidecarCommandEntrypointNeedsJavaScriptScan(artifactPath, packArtifacts, { allowScannableExtensionless = false } = {}) {
  if (explicitJavaScriptArtifactPath(artifactPath)) return !runtimeOptionDataArtifact(artifactPath);
  if (!extensionlessArtifactPath(artifactPath) || runtimeOptionDataArtifact(artifactPath)) return false;
  if (artifactShebangFirstLine(artifactPath, packArtifacts)) return artifactHasJavaScriptRuntimeShebang(artifactPath, packArtifacts);
  return allowScannableExtensionless && artifactHasScannableText(artifactPath, packArtifacts);
}

function artifactHasJavaScriptRuntimeShebang(artifactPath, packArtifacts) {
  return sidecarShebangRuntimeCommand([artifactPath], packArtifacts) !== null;
}

function artifactHasScannableText(artifactPath, packArtifacts) {
  const bytes = packArtifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return false;
  try {
    return !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0');
  } catch {
    return false;
  }
}

function artifactHasBunShebang(artifactPath, packArtifacts) {
  const firstLine = artifactShebangFirstLine(artifactPath, packArtifacts);
  return firstLine ? /(?:^|[/\s])bun(?:\s|$)/i.test(firstLine) : false;
}

function sidecarShebangRuntimeCommand(command, packArtifacts) {
  if (sidecarRuntimeCommandPosition(command, 0)) return null;
  const entrypoint = sidecarCommandEntrypointArtifact(command);
  if (!entrypoint) return null;
  const firstLine = artifactShebangFirstLine(entrypoint, packArtifacts);
  if (!firstLine) return null;
  const tokens = sidecarShebangTokens(firstLine);
  const runtimeIndex = tokens.findIndex((token) => SIDECAR_JS_RUNTIMES.has(commandBaseName(token).toLowerCase()));
  if (runtimeIndex < 0) {
    assertSafePackageManagerShebang(tokens, entrypoint, command.slice(1));
    return null;
  }
  assertSafeShebangRuntimePrefix(tokens, runtimeIndex);
  return [tokens[runtimeIndex], ...tokens.slice(runtimeIndex + 1), entrypoint, ...command.slice(1)];
}

function assertSafePackageManagerShebang(tokens, entrypoint, tail) {
  const command = sidecarPackageManagerShebangCommand(tokens, entrypoint, tail);
  if (!command) return;
  for (let index = 0; index < command.length; index += 1) assertSafeSidecarCommandToken(command, index);
}

function sidecarPackageManagerShebangCommand(tokens, entrypoint, tail) {
  const commandTokens = sidecarShebangCommandTokens(tokens);
  const executable = commandBaseName(commandTokens[0]).toLowerCase();
  if (!['bunx', 'corepack', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn'].includes(executable)) return null;
  return [...commandTokens, entrypoint, ...tail];
}

function sidecarShebangCommandTokens(tokens) {
  if (commandBaseName(tokens[0]).toLowerCase() !== 'env') return tokens;
  if (tokens[1] === '-S') return tokens.slice(2);
  return tokens.slice(1);
}

function assertSafeShebangRuntimePrefix(tokens, runtimeIndex) {
  const prefix = tokens.slice(0, runtimeIndex);
  if (!prefix.length) return;
  const envWrapper = commandBaseName(prefix[0]).toLowerCase() === 'env';
  if (envWrapper && (prefix.length === 1 || (prefix.length === 2 && prefix[1] === '-S'))) return;
  fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar shebang runtime wrappers must not set environment or options before the runtime');
}

function sidecarShebangTokens(firstLine) {
  const body = firstLine.slice(2).trim();
  if (/["'\\]/.test(body)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar shebang arguments must not use quotes or escapes');
  }
  return body.split(/\s+/).filter(Boolean);
}

function artifactShebangFirstLine(artifactPath, packArtifacts) {
  const bytes = packArtifacts[artifactPath];
  if (!(bytes instanceof Uint8Array)) return false;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!text.startsWith('#!')) return false;
  const lineEnd = text.search(/\r|\n/);
  return lineEnd < 0 ? text : text.slice(0, lineEnd);
}

function sidecarBunConfigPreloadArtifacts(command, packArtifacts) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun') return [];
  const artifacts = [];
  for (const configPath of sidecarBunConfigArtifacts(command)) {
    const bytes = packArtifacts[configPath];
    if (!(bytes instanceof Uint8Array)) continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    for (const preload of bunConfigPreloadEntries(text)) {
      if (!sidecarPreloadArtifact(preload)) {
        fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `bun config preload must reference a pack-relative checksum-covered artifact: ${preload}`);
      }
      artifacts.push(preload);
    }
  }
  return artifacts;
}

function sidecarBunConfigArtifacts(command) {
  const artifacts = [];
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    if (!sidecarRuntimeOptionPosition(command, index)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    const artifact = sidecarBunConfigOptionArtifact(command[index], command[index + 1]);
    if (artifact) artifacts.push(artifact);
    if (sidecarBunConfigOptionConsumesNext(command[index])) index += 1;
  }
  return artifacts;
}

function sidecarBunConfigOptionArtifact(value, nextValue) {
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  const option = value.slice(0, separator);
  return option === '--config' ? value.slice(separator + 1) : null;
}

function sidecarBunConfigOptionConsumesNext(value) {
  return false;
}

function sidecarDenoConfigArtifacts(command) {
  if (commandBaseName(command[0]).toLowerCase() !== 'deno') return [];
  const artifacts = [];
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    if (!sidecarRuntimeOptionPosition(command, index)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    const artifact = sidecarDenoConfigOptionArtifact(command[index], command[index + 1]);
    if (artifact) artifacts.push(artifact);
    if (sidecarDenoConfigOptionConsumesNext(command[index])) index += 1;
  }
  return artifacts;
}

function sidecarNodeConfigArtifacts(command) {
  if (commandBaseName(command[0]).toLowerCase() !== 'node') return [];
  const artifacts = [];
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    if (!sidecarRuntimeOptionPosition(command, index)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    const artifact = sidecarNodeConfigOptionArtifact(command[index], command[index + 1]);
    if (artifact) artifacts.push(artifact);
    if (sidecarNodeConfigOptionConsumesNext(command[index])) index += 1;
  }
  return artifacts;
}

function sidecarNodeConfigOptionArtifact(value, nextValue) {
  if (value === '--experimental-config-file') return nextValue;
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  return value.slice(0, separator) === '--experimental-config-file' ? value.slice(separator + 1) : null;
}

function sidecarNodeConfigOptionConsumesNext(value) {
  return value === '--experimental-config-file';
}

function sidecarNodeEnvFileArtifacts(command) {
  if (commandBaseName(command[0]).toLowerCase() !== 'node') return [];
  const artifacts = [];
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    if (!sidecarRuntimeOptionPosition(command, index)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    const artifact = sidecarNodeEnvFileOptionArtifact(command[index], command[index + 1]);
    if (artifact) artifacts.push(artifact);
    if (sidecarNodeEnvFileOptionConsumesNext(command[index])) index += 1;
  }
  return artifacts;
}

function sidecarNodeEnvFileOptionArtifact(value, nextValue) {
  if (value === '--env-file' || value === '--env-file-if-exists') return nextValue;
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  const option = value.slice(0, separator);
  return option === '--env-file' || option === '--env-file-if-exists' ? value.slice(separator + 1) : null;
}

function sidecarNodeEnvFileOptionConsumesNext(value) {
  return value === '--env-file' || value === '--env-file-if-exists';
}

function denoConfigExtendsArtifact(fromPath, extendsPath, covered) {
  if (!packRelativeConfigPath(extendsPath)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `Deno config extends must reference a pack-relative checksum-covered artifact: ${extendsPath}`);
  }
  const candidates = denoConfigExtendsArtifactCandidates(fromPath, extendsPath);
  const artifactPath = candidates.find((candidate) => covered.has(candidate));
  if (!artifactPath) {
    fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${candidates[0] ?? extendsPath}`);
  }
  return artifactPath;
}

function denoConfigExtendsArtifactCandidates(fromPath, extendsPath) {
  const from = normalizeArtifactPath(fromPath);
  const base = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const resolved = normalizeArtifactPath(base ? `${base}/${extendsPath}` : extendsPath);
  if (!resolved) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `Deno config extends must reference a pack-relative checksum-covered artifact: ${extendsPath}`);
  }
  return [...new Set([resolved, `./${resolved}`])];
}

function packRelativeConfigPath(value) {
  if (typeof value !== 'string' || !value.length) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return sidecarCommandArtifact(value);
}

function assertDenoConfigIsolated(command) {
  if (commandBaseName(command[0]).toLowerCase() !== 'deno') return;
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    if (!sidecarRuntimeOptionPosition(command, index)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    if (command[index] === '--no-config') return;
    if (sidecarDenoConfigOptionArtifact(command[index], command[index + 1])) return;
    if (sidecarDenoConfigOptionConsumesNext(command[index])) index += 1;
  }
  fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Deno sidecars must disable ambient config or use a checksum-covered config artifact');
}

function sidecarDenoConfigOptionArtifact(value, nextValue) {
  if (value === '--config' || value === '--config-file' || value === '-c') return nextValue;
  if (value.startsWith('-c=')) return value.slice(3);
  if (value.startsWith('-c') && !value.startsWith('--')) return value.slice(2);
  const separator = value.indexOf('=');
  if (separator < 0) return null;
  const option = value.slice(0, separator);
  return option === '--config' || option === '--config-file' ? value.slice(separator + 1) : null;
}

function sidecarDenoConfigOptionConsumesNext(value) {
  return value === '--config' || value === '--config-file' || value === '-c';
}

function bunConfigPreloadEntries(text) {
  const parsedEntries = bunTomlPreloadEntries(text);
  if (parsedEntries) return parsedEntries;
  const entries = [];
  const topLevelText = text.slice(0, tomlFirstTableOffset(text));
  let offset = 0;
  for (const line of topLevelText.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) break;
    const content = tomlLineWithoutComment(line[0]);
    const leading = content.match(/^\s*/)[0].length;
    if (leading < content.length) {
      const key = readTomlKey(topLevelText, offset + leading);
      const separator = key ? skipTomlInlineWhitespace(topLevelText, key.end) : -1;
      if (key?.value === 'preload' && topLevelText[separator] === '=') {
        entries.push(...tomlPreloadValueEntries(topLevelText, separator + 1));
      }
    }
    offset += line[0].length;
  }
  return entries;
}

function bunTomlPreloadEntries(text) {
  const parse = globalThis.Bun?.TOML?.parse;
  if (typeof parse !== 'function') return null;
  let config;
  try {
    config = parse(text);
  } catch {
    return [];
  }
  const preload = config?.preload;
  if (Array.isArray(preload)) return preload.filter((item) => typeof item === 'string');
  return typeof preload === 'string' ? [preload] : [];
}

function readTomlKey(text, index) {
  const quote = text[index];
  if (quote === '\'' || quote === '"') return readQuotedString(text, index, quote);
  const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
  return match ? { value: match[0], end: index + match[0].length } : null;
}

function tomlPreloadValueEntries(text, index) {
  const cursor = skipTomlInlineWhitespace(text, index);
  const char = text[cursor];
  if (char === '[') {
    const closeBracket = findTomlArrayClose(text, cursor);
    return tomlQuotedStringEntries(text.slice(cursor + 1, closeBracket));
  }
  if (char === '\'' || char === '"') {
    const literal = readQuotedString(text, cursor, char);
    return literal.value === null ? [] : [literal.value];
  }
  return [];
}

function skipTomlInlineWhitespace(text, index) {
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
  return index;
}

function tomlFirstTableOffset(text) {
  let offset = 0;
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) break;
    const content = tomlLineWithoutComment(line[0]).trimStart();
    if (content.startsWith('[')) return offset;
    offset += line[0].length;
  }
  return text.length;
}

function tomlLineWithoutComment(line) {
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '\'' || char === '"') {
      index = readQuotedString(line, index, char).end;
      continue;
    }
    if (char === '#') return line.slice(0, index);
    index += 1;
  }
  return line;
}

function findTomlArrayClose(text, openBracket) {
  let depth = 0;
  let index = openBracket;
  while (index < text.length) {
    const char = text[index];
    if (char === '#') {
      index = skipTomlComment(text, index);
      continue;
    }
    if (char === '\'' || char === '"') {
      index = readQuotedString(text, index, char).end;
      continue;
    }
    if (char === '[') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return text.length;
}

function tomlQuotedStringEntries(text) {
  const entries = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '#') {
      index = skipTomlComment(text, index);
      continue;
    }
    if (char === '\'' || char === '"') {
      const literal = readQuotedString(text, index, char);
      if (literal.value !== null) entries.push(literal.value);
      index = Math.max(index + 1, literal.end);
      continue;
    }
    index += 1;
  }
  return entries;
}

function skipTomlComment(text, index) {
  while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
  return index;
}

function sidecarPreloadArtifacts(command) {
  const artifacts = [];
  const entrypointIndex = sidecarEntrypointIndex(command);
  for (let index = 1; index < command.length; index += 1) {
    const value = command[index];
    if (!sidecarRuntimeOptionPosition(command, index) || !sidecarPreloadOption(value)) continue;
    if (entrypointIndex >= 0 && index > entrypointIndex) continue;
    const artifact = sidecarPreloadOptionArtifact(value, command[index + 1]);
    if (artifact) artifacts.push(artifact);
    if (sidecarPreloadOptionConsumesNext(value)) index += 1;
  }
  return artifacts;
}

function sidecarPreloadOptionArtifact(value, nextValue) {
  if (value.startsWith('-r') && value !== '-r') return value.slice(2);
  const separator = value.indexOf('=');
  if (separator >= 0) return value.slice(separator + 1);
  return nextValue;
}

function runtimeOptionDataArtifact(artifactPath) {
  return /\.(?:jsonc?|ya?ml|toml|ini|conf|cfg|env|pem|crt|cer|key)$/i.test(artifactPath) ||
    /(?:^|[/\\])\.env(?:\.[A-Za-z0-9._-]+)?$/i.test(artifactPath);
}

function sidecarRuntimeCommandPosition(command, index) {
  return index === 0 && SIDECAR_JS_RUNTIMES.has(commandBaseName(command[0]).toLowerCase());
}

function sidecarTypeScriptCapableRuntime(command) {
  return ['bun', 'deno'].includes(commandBaseName(command[0]).toLowerCase());
}

function sidecarUsesBunResolution(command, packArtifacts) {
  if (commandBaseName(command[0]).toLowerCase() === 'bun') return true;
  if (sidecarRuntimeCommandPosition(command, 0)) return false;
  const entrypoint = sidecarCommandEntrypointArtifact(command);
  return entrypoint ? artifactHasBunShebang(entrypoint, packArtifacts) : false;
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
  return sidecarPreloadOptionConsumesNext(value) || SIDECAR_RUNTIME_VALUE_OPTIONS.has(value);
}

function sidecarOptionValueArtifact(option, candidate) {
  return sidecarPreloadOptionConsumesNext(option) ? sidecarPreloadArtifact(candidate) : sidecarCommandArtifact(candidate);
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

function sidecarRuntimeInspectorOption(command, index) {
  if (!sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (typeof value !== 'string') return false;
  if (commandBaseName(command[0]).toLowerCase() === 'node' && value === 'inspect') return true;
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  return option.startsWith('--inspect') || option === '--debug-port';
}

function assertSafeSidecarCommandToken(command, index) {
  const value = command[index];
  const executable = commandBaseName(value).toLowerCase();
  if (sidecarUnsupportedBunEnvFileIfExistsOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support --env-file-if-exists');
  }
  if (sidecarUnsupportedBunCwdOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support --cwd');
  }
  if (sidecarUnsupportedBunNoConfigOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support --no-config');
  }
  if (sidecarUnsupportedBunEnvFileOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support caller-supplied env files');
  }
  if (sidecarUnsupportedBunConfigOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support caller-supplied config files');
  }
  if (sidecarUnsupportedBunCodeLoadingOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support inline code or preload options');
  }
  if (sidecarUnsupportedBunNetworkOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'Bun sidecars do not support preconnect options');
  }
  if (index === 0 && SIDECAR_RUNTIME_WRAPPERS.has(executable)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command wraps runtime execution outside checksum coverage: ${value}`);
  }
  if (index === 0 && bareScriptEntrypoint(value)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar script entrypoints must be path-qualified');
  }
  if (index === 0 && pathQualifiedJavaScriptEntrypoint(value)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar JavaScript entrypoints must use an explicit runtime command');
  }
  if (index === 0 && ['bunx', 'npx', 'pnpx'].includes(executable)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes packages outside checksum coverage: ${value}`);
  }
  if (sidecarPackageExecBeforeArtifact(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes packages outside checksum coverage: ${command[0]} ${value}`);
  }
  if (sidecarPackageRuntimeBeforeArtifact(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command wraps runtime execution outside checksum coverage: ${command[0]} ${value}`);
  }
  if (sidecarDenoTaskBeforeArtifact(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes deno task outside checksum coverage: ${command[0]} ${value}`);
  }
  if (sidecarRuntimeEvalFlag(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command evaluates inline code outside checksum coverage: ${value}`);
  }
  if (sidecarRuntimeInspectorOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command opens runtime inspector outside receiver policy: ${value}`);
  }
  if (sidecarRuntimeModuleLoaderOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command loads runtime modules outside checksum coverage: ${value}`);
  }
  if (sidecarRuntimePackageScriptOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command executes package scripts outside checksum coverage: ${value}`);
  }
  if (sidecarRuntimePermissionGrantOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command grants runtime permissions outside receiver policy: ${value}`);
  }
  if (sidecarRuntimeImportMapOption(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', 'sidecar command import maps are not supported');
  }
  if (sidecarRuntimeRemoteEntrypoint(command, index)) {
    fail('ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE', `sidecar command uses a remote runtime entrypoint outside checksum coverage: ${value}`);
  }
}

function sidecarUnsupportedBunEnvFileIfExistsOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--env-file-if-exists' && !value.startsWith('--env-file-if-exists=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunCwdOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--cwd' && !value.startsWith('--cwd=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunNoConfigOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--no-config' && !value.startsWith('--no-config=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunEnvFileOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--env-file' && !value.startsWith('--env-file=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunConfigOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (!(value === '--config' || value.startsWith('--config=') ||
    value === '--config-file' || value.startsWith('--config-file=') ||
    value === '-c' || value.startsWith('-c=') || (value.startsWith('-c') && value !== '-c'))) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunCodeLoadingOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (!(value === '-e' || value === '--eval' || value.startsWith('-e') || value.startsWith('--eval=') ||
    value === '-p' || value.startsWith('-p') || value === '--print' || value.startsWith('--print=') ||
    value === '--inspect' || value.startsWith('--inspect=') ||
    value === '--inspect-brk' || value.startsWith('--inspect-brk=') ||
    value === '--inspect-wait' || value.startsWith('--inspect-wait=') ||
    value === '--import' || value.startsWith('--import=') ||
    value === '-r' || value.startsWith('-r') ||
    value === '--require' || value.startsWith('--require=') ||
    value === '--preload' || value.startsWith('--preload='))) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarUnsupportedBunNetworkOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'bun' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--fetch-preconnect' && !value.startsWith('--fetch-preconnect=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
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

function sidecarRuntimeModuleLoaderOption(command, index) {
  if (!sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  if (!SIDECAR_MODULE_LOADER_OPTIONS.has(option)) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarRuntimePackageScriptOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'node' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  if (value !== '--run' && !value.startsWith('--run=')) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarRuntimePermissionGrantOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'deno' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  if (!denoPermissionGrantOption(option)) return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function denoPermissionGrantOption(option) {
  return option === '-A' || option.startsWith('-A=') ||
    option === '-E' || option.startsWith('-E=') ||
    option === '-F' || option.startsWith('-F=') ||
    option === '-N' || option.startsWith('-N=') ||
    option === '-P' || option.startsWith('-P=') ||
    option === '-R' || option.startsWith('-R=') ||
    option === '-S' || option.startsWith('-S=') ||
    option === '-W' || option.startsWith('-W=') ||
    option === '--allow-all' || option === '--permission-set' ||
    option.startsWith('--permission-set=') ||
    option.startsWith('--allow-');
}

function sidecarRuntimeImportMapOption(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'deno' || !sidecarRuntimeOptionPosition(command, index)) return false;
  const value = command[index];
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  if (option !== '--import-map') return false;
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

function sidecarCommandEntrypointArtifact(command) {
  if (sidecarRuntimeCommandPosition(command, 0)) return sidecarRuntimeEntrypointArtifact(command);
  return sidecarCommandArtifact(command[0]) ? command[0] : null;
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
  const runtime = commandBaseName(command[0]).toLowerCase();
  if (runtime === 'bun') {
    if (sidecarBunConfigOptionConsumesNext(previous)) return true;
    if (sidecarBunConfigOptionArtifact(previous, undefined)) return false;
  }
  if (runtime === 'deno') {
    if (previous === '--no-config') return false;
    if (sidecarDenoConfigOptionConsumesNext(previous)) return true;
    if (sidecarDenoConfigOptionArtifact(previous, undefined)) return false;
  }
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
  if (sidecarCorepackPackageExecBeforeArtifact(command, index)) return true;
  if (index < 1 || !SIDECAR_PACKAGE_MANAGER_SCRIPT_COMMANDS.has(String(command[index]).toLowerCase())) return false;
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(commandBaseName(command[0]).toLowerCase())) return false;
  for (let cursor = 1; cursor < index; cursor += 1) {
    if (sidecarCommandArtifact(command[cursor]) && !sidecarPackageManagerOptionValuePosition(command, cursor)) return false;
  }
  return true;
}

function sidecarCorepackPackageExecBeforeArtifact(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'corepack') return false;
  if (index < 2 || !SIDECAR_PACKAGE_MANAGER_SCRIPT_COMMANDS.has(String(command[index]).toLowerCase())) return false;
  const packageManager = String(command[1]).toLowerCase();
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(packageManager)) return false;
  for (let cursor = 2; cursor < index; cursor += 1) {
    if (sidecarCommandArtifact(command[cursor]) && !sidecarPackageManagerOptionValuePosition(command, cursor, 1)) return false;
  }
  return true;
}

function sidecarPackageRuntimeBeforeArtifact(command, index) {
  if (!SIDECAR_JS_RUNTIMES.has(commandBaseName(command[index]).toLowerCase())) return false;
  if (sidecarCorepackPackageRuntimeBeforeArtifact(command, index)) return true;
  if (index < 1 || !['bun', 'npm', 'pnpm', 'yarn'].includes(commandBaseName(command[0]).toLowerCase())) return false;
  for (let cursor = 1; cursor < index; cursor += 1) {
    if (sidecarCommandArtifact(command[cursor]) && !sidecarPackageManagerOptionValuePosition(command, cursor)) return false;
  }
  return true;
}

function sidecarCorepackPackageRuntimeBeforeArtifact(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'corepack') return false;
  if (index < 2) return false;
  const packageManager = String(command[1]).toLowerCase();
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(packageManager)) return false;
  for (let cursor = 2; cursor < index; cursor += 1) {
    if (sidecarCommandArtifact(command[cursor]) && !sidecarPackageManagerOptionValuePosition(command, cursor, 1)) return false;
  }
  return true;
}

function sidecarDenoTaskBeforeArtifact(command, index) {
  if (commandBaseName(command[0]).toLowerCase() !== 'deno') return false;
  if (String(command[index]).toLowerCase() !== 'task') return false;
  const entrypointIndex = sidecarEntrypointIndex(command);
  return entrypointIndex < 0 || index < entrypointIndex;
}

function sidecarPackageManagerOptionValuePosition(command, index, packageManagerIndex = 0) {
  if (index < packageManagerIndex + 2 || !['bun', 'npm', 'pnpm', 'yarn'].includes(commandBaseName(command[packageManagerIndex]).toLowerCase())) return false;
  const previous = command[index - 1];
  if (typeof previous !== 'string' || !previous.startsWith('-') || previous.includes('=')) return false;
  return SIDECAR_PACKAGE_MANAGER_VALUE_OPTIONS.has(previous);
}

function commandBaseName(value) {
  return String(value).split(/[\\/]/).at(-1).replace(/\.exe$/i, '');
}

function bareSidecarRuntimeExecutable(value) {
  if (typeof value !== 'string' || !value.length) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return SIDECAR_JS_RUNTIMES.has(commandBaseName(value).toLowerCase());
}

function bareScriptEntrypoint(value) {
  if (typeof value !== 'string' || value.includes('/') || value.includes('\\')) return false;
  return /\.(?:cjs|cts|js|jsx|mjs|mts|py|rb|sh|ts|tsx)$/i.test(value);
}

function pathQualifiedJavaScriptEntrypoint(value) {
  if (typeof value !== 'string' || (!value.includes('/') && !value.includes('\\'))) return false;
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(value);
}

function sidecarCommandArtifact(value) {
  if (typeof value !== 'string' || !value.length) return false;
  if (value.startsWith('-')) return false;
  if (/[?#]/.test(value)) return false;
  if (value.startsWith('@') && !value.includes('/') && !sidecarArtifactPath(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (sidecarEnvAssignment(value) && !sidecarArtifactPath(value)) return false;
  if (bareSidecarRuntimeExecutable(value)) return false;
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
    if (!javascriptArtifactPath(module)) fail('ERR_CAPABILITY_ADAPTER_INVALID', 'in_process adapter module must be a JavaScript artifact');
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
    const credentialPath = SECRET_PATTERN.test(path.join('.'));
    const secretShapedValue = concreteSecretValue(value) || /sk-[A-Za-z0-9_-]{8,}/.test(value);
    if (
      (descriptorLabel && secretShapedValue) ||
      (!descriptorLabel && ((credentialPath && value.length > 0 && !allowedSentinel) || secretShapedValue))
    ) {
      fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like value forbidden at ${path.join('.')}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, [...path, String(index)]));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assertNoCredentialKeyMaterial(key);
      assertNoCredentialMaterial(child, [...path, key]);
    }
  }
}

function assertNoMetadataCredentialMaterial(value) {
  if (value instanceof Uint8Array) {
    assertNoMetadataBytesCredentialMaterial(value);
    return;
  }
  if (typeof value === 'string') {
    assertNoMetadataBytesCredentialMaterial(fromUtf8(value));
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
    for (const [key, child] of Object.entries(value)) {
      assertNoCredentialKeyMaterial(key);
      assertNoConformanceCredentialMaterial(child, [...path, key]);
    }
  }
}

function assertNoCredentialKeyMaterial(key) {
  if (concreteSecretValue(key) || /sk-[A-Za-z0-9_-]{8,}/.test(key)) {
    fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', 'credential-like key forbidden');
  }
}

function concreteSecretValue(value) {
  return (
    /\b(?:bearer|basic)\s+\S+/i.test(value) ||
    /(?:^|[?&;,\s{]|-{1,2})(?:credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key)\s*[:=]\s*\S+/i.test(value)
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
