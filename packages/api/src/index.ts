export { createApp, type AppDeps } from './app.js';
export { openApiDocument } from './openapi.js';
export {
  createPlatformApp,
  type PlatformDeps,
  type PlatformStore,
  type PlatformTenantView,
} from './platform.js';
// The signer of the running application, for a test that must mint a link the server accepts
// (an unsubscribe link, before any bulk send makes one) from the same SIGNING_SECRET.
export { HmacSigner } from './runtime/signer.js';
