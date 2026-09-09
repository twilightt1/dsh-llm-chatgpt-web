//#region src/native/mcp-main.d.ts
/** Parse the intentionally narrow executable CLI. */
declare function runDshNativeMcpMain(args: readonly string[]): Promise<void>;
//#endregion
export { runDshNativeMcpMain };