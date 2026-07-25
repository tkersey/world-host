import { ApplicationWorker } from '../v1/index.mjs';

globalThis.onmessage = async ({ data }) => {
  const worker = new ApplicationWorker(data.workerOptions);
  try {
    const runtime = await worker.instantiate(new Uint8Array(data.wasmBytes));
    const manifest = worker.readManifest();
    globalThis.postMessage({
      ok: true,
      inspection: {
        application: {
          name: manifest.applicationName,
          applicationId: hex(manifest.applicationId),
          applicationVersion: manifest.applicationVersion,
        },
        abi: {
          application: manifest.worldApplicationAbiVersion,
          frame: 1,
          boundaryStaticMachine: manifest.boundaryStaticMachineAbiVersion,
          boundaryPackage: manifest.boundaryPackageVersion,
          worldPackage: manifest.worldPackageVersion,
        },
        residualEffects: manifest.residualEffects.map((effect) => ({
          interfaceId: hex(effect.interfaceId),
          siteId: effect.siteId.toString(),
          payloadSchemaId: hex(effect.payloadSchemaId),
          resultSchemaId: hex(effect.resultSchemaId),
          allowedStatuses: effect.allowedStatuses,
          authorityRequirements: effect.authorityRequirements.toString(),
        })),
        requiredHostCapabilities: manifest.requiredHostCapabilities.toString(),
        memory: {
          initialBytes: runtime.initialMemoryBytes,
          maximumBytes: runtime.maximumMemoryBytes,
        },
        wasm: {
          byteLength: runtime.wasmByteLength,
          importCount: runtime.importCount,
        },
      },
    });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'ERR_APPLICATION_V1_WASM_INSPECTION',
        message: error?.message ?? String(error),
        details: error?.details ?? {},
      },
    });
  } finally {
    worker.dispose();
  }
};

function hex(value) {
  return Buffer.from(value).toString('hex');
}
