declare module '*.md' {
  const content: string;
  export default content;
}

declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
