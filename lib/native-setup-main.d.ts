import "./chunks/types-CkBIayy6.js";
//#region src/native/setup.d.ts
interface NativeSetupInput {
  readonly isTTY: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'data' | 'error', listener: (...args: never[]) => void): this;
}
interface NativeSetupIo {
  readonly stdin: NativeSetupInput;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}
//#endregion
//#region src/native/setup-main.d.ts
declare function readHiddenRuntimeKey(io: NativeSetupIo): Promise<string>;
declare function runDshNativeSetupMain(args: readonly string[], io?: NativeSetupIo): Promise<number>;
//#endregion
export { readHiddenRuntimeKey, runDshNativeSetupMain };