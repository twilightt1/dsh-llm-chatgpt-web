import { LlmError } from "@deepseek-ai/dsh-llm";
//#region src/native/errors.ts
/** A policy denial is recoverable within the same still-valid broker round. */
var NativePolicyDeniedError = class extends Error {
	code = "NATIVE_POLICY_DENIED";
	releaseRound = false;
	constructor(message) {
		super(message);
		this.name = "NativePolicyDeniedError";
	}
};
/** A native safety failure is an invalid request, never a provider retry. */
var NativeSafetyError = class extends LlmError {
	nativeCode;
	retryable = false;
	constructor(message, cause, nativeCode = "NATIVE_SAFETY") {
		super(message, "INVALID_REQUEST", cause === void 0 ? void 0 : { cause });
		this.name = "NativeSafetyError";
		this.nativeCode = nativeCode;
	}
};
/** A missing or stale local policy grant blocks before any provider side effect. */
var NativeApprovalRequiredError = class extends NativeSafetyError {
	nativeCode = "NATIVE_APPROVAL_REQUIRED";
	constructor(message, cause) {
		super(message, cause, "NATIVE_APPROVAL_REQUIRED");
		this.name = "NativeApprovalRequiredError";
	}
};
//#endregion
export { NativePolicyDeniedError as n, NativeSafetyError as r, NativeApprovalRequiredError as t };
