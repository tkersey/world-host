import { fail } from "./errors.mjs";

export function createAgentInvokeAdapter({ invokeChild }) {
  if (typeof invokeChild !== "function") fail("ERR_CAPABILITY_V1_AGENT_INVOKER");
  return Object.freeze({
    preflight: async (context, request) => {
      const reason = preflightReason(context, request);
      return reason === null
        ? { requestId: request.requestId, status: "ok", payload: { ready: true } }
        : { requestId: request.requestId, status: "rejected", payload: { reason } };
    },
    resolve: async (context, request) => {
      const reason = preflightReason(context, request);
      if (reason !== null) return { requestId: request.requestId, status: "rejected", payload: { reason } };
      context.effectAttempted = (context.effectAttempted ?? 0) + 1;
      const outcome = await invokeChild({
        applicationId: request.payload.applicationId,
        input: request.payload.input,
        maximumSteps: request.payload.maximumSteps,
        fuelPerStep: request.payload.fuelPerStep,
        idempotencyKey: request.idempotencyKey
      });
      if (!outcome || typeof outcome !== "object") {
        return { requestId: request.requestId, status: "failed", payload: { reason: "invalid_child_outcome" } };
      }
      if (outcome.status === "deferred") {
        return { requestId: request.requestId, status: "deferred", payload: { reason: "child_deferred" } };
      }
      if (outcome.status !== "completed" || typeof outcome.result !== "string") {
        return { requestId: request.requestId, status: "failed", payload: { reason: "child_failed" } };
      }
      return { requestId: request.requestId, status: "ok", payload: { result: outcome.result } };
    }
  });
}

function preflightReason(context, request) {
  if (!request?.requestId || !request?.idempotencyKey) return "invalid_request";
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || typeof payload.applicationId !== "string" ||
      !/^[0-9a-f]{64}$/.test(payload.applicationId) || typeof payload.input !== "string" ||
      !Number.isSafeInteger(payload.maximumSteps) || payload.maximumSteps <= 0 || payload.maximumSteps > 1024 ||
      !Number.isSafeInteger(payload.fuelPerStep) || payload.fuelPerStep <= 0 ||
      (Number.isSafeInteger(context?.policy?.maximumChildSteps) &&
        payload.maximumSteps > context.policy.maximumChildSteps) ||
      (Number.isSafeInteger(context?.policy?.maximumChildFuelPerStep) &&
        payload.fuelPerStep > context.policy.maximumChildFuelPerStep)) {
    return "invalid_child_request";
  }
  if (context?.policy?.childAgentLive !== true) return "child_agent_denied";
  if (!Array.isArray(context?.policy?.allowedChildApplications) ||
      !context.policy.allowedChildApplications.includes(payload.applicationId)) {
    return "child_application_denied";
  }
  if (context?.policy?.approvalRequired && context?.approval?.approved !== true) return "approval_required";
  return null;
}
