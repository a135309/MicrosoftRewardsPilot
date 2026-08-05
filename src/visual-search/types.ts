import { ConfigDuration } from '../../interfaces/Config'

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
