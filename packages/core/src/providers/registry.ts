import { freebuffProvider } from './freebuff.js'
import { qoderProvider } from './qoder.js'
import { kiloProvider } from './kilo.js'
import { copilotProvider } from './copilot.js'
import type { Provider } from './contract.js'

export const CLOUD_PROVIDERS: Provider<any>[] = [copilotProvider, kiloProvider, qoderProvider, freebuffProvider]

export const LOCAL_HTTP_PROVIDERS: Provider<any>[] = []
