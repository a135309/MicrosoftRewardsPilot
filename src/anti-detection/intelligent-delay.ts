import ms from 'ms'

export interface SearchDelayRangeMs {
    min: number
    max: number
}

export interface NormalizedSearchDelayConfig {
    desktop: SearchDelayRangeMs
    mobile: SearchDelayRangeMs
    longPauseProbability: number
    longPause: SearchDelayRangeMs
    hardMax: number
}

const DEFAULT_SEARCH_DELAY_CONFIG: NormalizedSearchDelayConfig = {
    desktop: { min: 25_000, max: 60_000 },
    mobile: { min: 20_000, max: 45_000 },
    longPauseProbability: 0.01,
    longPause: { min: 60_000, max: 120_000 },
    hardMax: 120_000
}

export function getDefaultSearchDelayConfig(): NormalizedSearchDelayConfig {
    return {
        desktop: { ...DEFAULT_SEARCH_DELAY_CONFIG.desktop },
        mobile: { ...DEFAULT_SEARCH_DELAY_CONFIG.mobile },
        longPauseProbability: DEFAULT_SEARCH_DELAY_CONFIG.longPauseProbability,
        longPause: { ...DEFAULT_SEARCH_DELAY_CONFIG.longPause },
        hardMax: DEFAULT_SEARCH_DELAY_CONFIG.hardMax
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDuration(value: unknown, label: string): number {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
            ? ms(value)
            : Number.NaN

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive duration`)
    }
    return parsed
}

function parseRange(value: unknown, label: string): SearchDelayRangeMs {
    if (!isRecord(value)) {
        throw new Error(`${label} must contain min and max durations`)
    }

    const min = parseDuration(value.min, `${label}.min`)
    const max = parseDuration(value.max, `${label}.max`)
    if (min > max) {
        throw new Error(`${label}.min must be less than or equal to ${label}.max`)
    }
    return { min, max }
}

/** Normalize current delay settings and reject ambiguous or unsafe values. */
export function normalizeSearchDelayConfig(
    raw: unknown,
    warn: (message: string) => void = message => console.warn(message)
): NormalizedSearchDelayConfig {
    if (raw === undefined || raw === null) {
        return getDefaultSearchDelayConfig()
    }

    if (!isRecord(raw)) {
        throw new Error('searchSettings.searchDelay must be an object')
    }

    const keys = Object.keys(raw)
    const isExactLegacyShape = keys.length === 2 && keys.includes('min') && keys.includes('max')
    if (isExactLegacyShape) {
        warn('[CONFIG] Legacy searchSettings.searchDelay {min,max} is deprecated; using new search-delay defaults')
        return getDefaultSearchDelayConfig()
    }
    if ('min' in raw || 'max' in raw) {
        throw new Error('searchSettings.searchDelay mixes legacy and current fields; migrate to the current shape')
    }

    const desktop = parseRange(raw.desktop, 'searchSettings.searchDelay.desktop')
    const mobile = parseRange(raw.mobile, 'searchSettings.searchDelay.mobile')
    const longPause = parseRange(raw.longPause, 'searchSettings.searchDelay.longPause')
    const probability = raw.longPauseProbability
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error('searchSettings.searchDelay.longPauseProbability must be a number between 0 and 1')
    }
    const hardMax = parseDuration(raw.hardMax, 'searchSettings.searchDelay.hardMax')
    if (hardMax < Math.max(desktop.min, mobile.min, longPause.min)) {
        throw new Error('searchSettings.searchDelay.hardMax must be greater than or equal to all configured minima')
    }

    return { desktop, mobile, longPauseProbability: probability, longPause, hardMax }
}

/**
 * Bounded log-normal search spacing. Long pauses replace normal samples; all results are capped last.
 */
export class IntelligentDelaySystem {
    private lastActivityTime = 0
    private sessionStartTime = Date.now()

    constructor(
        private readonly settings: NormalizedSearchDelayConfig = getDefaultSearchDelayConfig(),
        private readonly rng: () => number = Math.random
    ) {}

    calculateSearchDelay(_searchIndex: number, isMobile: boolean, _hasFailures = false): number {
        const now = Date.now()
        const range = isMobile ? this.settings.mobile : this.settings.desktop

        let delay: number
        if (this.randomUnit() < this.settings.longPauseProbability) {
            delay = this.randomInclusive(this.settings.longPause.min, this.settings.longPause.max)
        } else {
            delay = this.logNormalDelay(range.min, range.max)
        }

        this.lastActivityTime = now
        return Math.floor(Math.min(delay, this.settings.hardMax))
    }

    private randomUnit(): number {
        const value = this.rng()
        if (!Number.isFinite(value)) return 0
        return Math.min(0.999999999, Math.max(0, value))
    }

    private randomInclusive(min: number, max: number): number {
        return Math.floor(min + this.randomUnit() * (max - min + 1))
    }

    private logNormalDelay(min: number, max: number): number {
        const span = max - min
        if (span <= 0) return min

        const u1 = Math.max(1e-9, this.randomUnit())
        const u2 = this.randomUnit()
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        const sample = Math.exp(0.6 * z)
        const scaled = min + span * 0.3 * sample
        return Math.max(min, Math.min(max, scaled))
    }

    resetSession(): void {
        this.sessionStartTime = Date.now()
        this.lastActivityTime = 0
    }

    getStatus(): { consecutiveFailures: number; sessionDuration: number; lastActivityTime: number } {
        return {
            consecutiveFailures: 0,
            sessionDuration: Date.now() - this.sessionStartTime,
            lastActivityTime: this.lastActivityTime
        }
    }
}
