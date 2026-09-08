import { preview } from 'vite';

/** Await Vite's listening socket, never its human-readable (possibly coloured) URL. */
export async function startPreview(root, port) {
  const server = await preview({
    root,
    logLevel: 'silent',
    preview: { host: '127.0.0.1', port, strictPort: true, open: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Preview has no TCP listener');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.httpServer.close((error) => error ? reject(error) : resolve());
      server.httpServer.closeAllConnections();
    }),
  };
}
