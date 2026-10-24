import { freebuffProvider } from './freebuff.js'
import { qoderProvider } from './qoder.js'
import { kiloProvider } from './kilo.js'
import { copilotProvider } from './copilot.js'
import { grokProvider } from './grok.js'
import { cursorProvider } from './cursor.js'
import { mimoProvider } from './mimo.js'
import { opencodeProvider } from './opencode.js'
import type { Provider } from './contract.js'

export const CLOUD_PROVIDERS: Provider<any>[] = [copilotProvider, kiloProvider, qoderProvider, freebuffProvider, grokProvider, cursorProvider]

export const LOCAL_HTTP_PROVIDERS: Provider<any>[] = [mimoProvider, opencodeProvider]
