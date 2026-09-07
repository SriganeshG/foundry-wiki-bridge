declare module "@mixmark-io/domino" {
  const domino: {
    createDocument(html?: string, force?: boolean): Document;
    createWindow(html?: string, address?: string): Window & typeof globalThis;
  };
  export = domino;
}
