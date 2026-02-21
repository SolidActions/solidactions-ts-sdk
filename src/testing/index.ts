/**
 * SolidActions SDK Testing Utilities
 *
 * Import from '@solidactions/sdk/testing' to use the mock server
 * for local development and testing without a real backend.
 *
 * Usage:
 *   import { createMockServer } from '@solidactions/sdk/testing';
 *   const server = await createMockServer();
 *   console.log(server.baseUrl); // http://127.0.0.1:<port>
 */

export { MockHttpServer, MockStore, createMockServer } from './mock_server';
