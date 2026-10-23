import { copilotProvider } from './copilot.js'
import type { Provider } from './contract.js'

export const CLOUD_PROVIDERS: Provider<any>[] = [copilotProvider]

export const LOCAL_HTTP_PROVIDERS: Provider<any>[] = []
