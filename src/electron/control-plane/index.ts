/**
 * WebSocket Control Plane
 *
 * A WebSocket-based control plane for remote management of CoWork.
 * Provides a single entry point for clients, tools, and events.
 */

export { ControlPlaneServer, type ControlPlaneConfig } from './server';
export { type ControlPlaneClient, type ClientInfo } from './client';
export {
  type RequestFrame,
  type ResponseFrame,
  type EventFrame,
  type Frame,
  FrameType,
  parseFrame,
  serializeFrame,
  createRequestFrame,
  createResponseFrame,
  createEventFrame,
} from './protocol';
export {
  ControlPlaneSettingsManager,
  type ControlPlaneSettings,
  DEFAULT_REMOTE_GATEWAY_CONFIG,
} from './settings';
export {
  setupControlPlaneHandlers,
  shutdownControlPlane,
  getControlPlaneServer,
} from './handlers';
export {
  RemoteGatewayClient,
  getRemoteGatewayClient,
  initRemoteGatewayClient,
  shutdownRemoteGatewayClient,
  type RemoteGatewayClientOptions,
} from './remote-client';
export {
  SSHTunnelManager,
  getSSHTunnelManager,
  initSSHTunnelManager,
  shutdownSSHTunnelManager,
  DEFAULT_SSH_TUNNEL_CONFIG,
} from './ssh-tunnel';
