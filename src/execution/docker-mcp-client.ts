/**
 * @deprecated Use `DockerMcpGateway` from `./docker-mcp-gateway.js` instead.
 *
 * This module re-exports DockerMcpGateway under the old DockerMcpClient name
 * for backward compatibility. New code should import from docker-mcp-gateway.js.
 */
export { DockerMcpGateway as DockerMcpClient } from './docker-mcp-gateway.js';
export type { DockerMcpGatewayOptions as DockerMcpClientOptions } from './docker-mcp-gateway.js';
