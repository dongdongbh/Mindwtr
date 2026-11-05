#!/usr/bin/env node


import { logError, startMcpServer } from './index.js';

startMcpServer().catch((error) => {
  logError('Failed to start server', error);
  process.exit(1);
});
