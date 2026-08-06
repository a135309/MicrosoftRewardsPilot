import { AccountProxy } from '../../interfaces/Account'
import { ConfigDuration, ConfigVisualSearchProxy } from '../../interfaces/Config'

export interface VisualSearchProgress {
    current: number
    max: number
}

export type VisualSearchScreeningStatus = 'absent' | 'already_complete' | 'candidate' | 'uncertain'

export interface VisualSearchCandidate {
    email: string
    taskUrl: string
    language: string
    cardBefore: VisualSearchProgress
    drawerBefore: VisualSearchProgress
}

export interface VisualSearchScreeningResult {
    status: VisualSearchScreeningStatus
    language: string
    reason?: string
    candidate?: VisualSearchCandidate
}

export type VisualSearchResultStatus = 'completed' | 'unconfirmed' | 'failed' | 'skipped'

export interface VisualSearchResult {
    email: string
    status: VisualSearchResultStatus
    reason?: string
    cardAfter?: VisualSearchProgress
    drawerAfter?: VisualSearchProgress
}

export interface VisualSearchConfig {
    imageDirectory: string
    taskTimeout: ConfigDuration
    completionTimeout: ConfigDuration
    maxUploadAttempts: number
    proxy?: ConfigVisualSearchProxy
}

export const DEFAULT_VISUAL_SEARCH_CONFIG: VisualSearchConfig = {
    imageDirectory: 'visual-search-images',
    taskTimeout: '3min',
    completionTimeout: '90s',
    maxUploadAttempts: 1
}

export function resolveVisualSearchConfig(config?: Partial<VisualSearchConfig>): VisualSearchConfig {
    return {
        ...DEFAULT_VISUAL_SEARCH_CONFIG,
        ...config
    }
}

function parseVisualSearchProxyServer(server: string): { url: string; port: number } {
    let parsed: URL
    try {
        parsed = new URL(server)
    } catch {
        throw new Error('Visual Search proxy server is invalid')
    }

    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('Visual Search proxy protocol or host is invalid')
    }
    if (!parsed.port) {
        throw new Error('Visual Search proxy server must include a port')
    }
    if (parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
        throw new Error('Visual Search proxy server must contain only protocol, host, and port')
    }

    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Visual Search proxy port is invalid')
    }

    return {
        url: `${parsed.protocol}//${parsed.hostname}`,
        port
    }
}

export function resolveVisualSearchProxy(
    config: VisualSearchConfig,
    environment: NodeJS.ProcessEnv = process.env
): AccountProxy {
    const configured = config.proxy
    const environmentServer = environment.VISUAL_SEARCH_PROXY_SERVER
    const environmentOverridesServer = environmentServer !== undefined
    const server = environmentOverridesServer
        ? environmentServer.trim()
        : configured?.server?.trim()

    if (!server) {
        throw new Error('Visual Search proxy is required')
    }

    const parsed = parseVisualSearchProxyServer(server)
    const username = environment.VISUAL_SEARCH_PROXY_USERNAME !== undefined
        ? environment.VISUAL_SEARCH_PROXY_USERNAME
        : environmentOverridesServer ? '' : configured?.username ?? ''
    const password = environment.VISUAL_SEARCH_PROXY_PASSWORD !== undefined
        ? environment.VISUAL_SEARCH_PROXY_PASSWORD
        : environmentOverridesServer ? '' : configured?.password ?? ''

    return {
        proxyAxios: true,
        url: parsed.url,
        port: parsed.port,
        username,
        password
    }
}

export function validateVisualSearchConfig(config: unknown): string[] {
    if (config === undefined) return []
    if (!config || typeof config !== 'object' || Array.isArray(config)) return ['visualSearch must be an object']

    const value = config as Record<string, unknown>
    const issues: string[] = []
    if (value.imageDirectory !== undefined && (typeof value.imageDirectory !== 'string' || value.imageDirectory.trim() === '')) {
        issues.push('visualSearch.imageDirectory must be a non-empty string')
    }
    for (const key of ['taskTimeout', 'completionTimeout'] as const) {
        const duration = value[key]
        const validString = typeof duration === 'string' && /^\d+(?:\.\d+)?\s*(?:ms|s|m|min|h|d)$/i.test(duration.trim())
        if (duration !== undefined && !((typeof duration === 'number' && duration > 0) || validString)) {
            issues.push(`visualSearch.${key} must be a positive duration`)
        }
    }
    if (value.maxUploadAttempts !== undefined && value.maxUploadAttempts !== 1) {
        issues.push('visualSearch.maxUploadAttempts must be 1')
    }
    if (value.proxy !== undefined) {
        if (!value.proxy || typeof value.proxy !== 'object' || Array.isArray(value.proxy)) {
            issues.push('visualSearch.proxy must be an object')
        } else {
            const proxy = value.proxy as Record<string, unknown>
            if (typeof proxy.server !== 'string' || proxy.server.trim() === '') {
                issues.push('visualSearch.proxy.server must be a non-empty string')
            } else {
                try {
                    parseVisualSearchProxyServer(proxy.server.trim())
                } catch (error) {
                    issues.push(error instanceof Error ? error.message : String(error))
                }
            }
            for (const key of ['username', 'password'] as const) {
                if (proxy[key] !== undefined && typeof proxy[key] !== 'string') {
                    issues.push(`visualSearch.proxy.${key} must be a string`)
                }
            }
        }
    }
    return issues
}

export function isVisualSearchComplete(
    cardBefore: VisualSearchProgress,
    drawerBefore: VisualSearchProgress,
    cardAfter: VisualSearchProgress,
    drawerAfter: VisualSearchProgress
): boolean {
    return cardAfter.current > cardBefore.current &&
        drawerAfter.current > drawerBefore.current &&
        cardAfter.current === cardAfter.max &&
        drawerAfter.current === drawerAfter.max
}
