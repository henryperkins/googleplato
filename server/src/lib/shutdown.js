export function installShutdown(server, closeDatabase, { timeoutMs = 8000 } = {}) {
  let closing = false;
  process.on('SIGTERM', () => {
    if (closing) return;
    closing = true;
    // Leave time before Cloud Run's ten-second SIGKILL deadline. An open
    // response or stuck database teardown must not keep the process alive.
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: 'shutdown_timeout' }));
      server.closeAllConnections();
      process.exit(1);
    }, timeoutMs);
    server.close(async error => {
      try {
        if (error) throw error;
        await closeDatabase();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        // Connection errors may contain credentials; only log the error code.
        console.error(JSON.stringify({ event: 'shutdown_error', code: error.code }));
        clearTimeout(deadline);
        process.exit(1);
      }
    });
  });
}
