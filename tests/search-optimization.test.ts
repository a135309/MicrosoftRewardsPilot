import assert from 'assert'

import type { Page } from 'rebrowser-playwright'

import { IntelligentDelaySystem, getDefaultSearchDelayConfig, normalizeSearchDelayConfig } from '../src/anti-detection/intelligent-delay'
import { SearchRunner } from '../src/rewards-api/SearchRunner'
import type { ApiPromotion, RewardsApi } from '../src/rewards-api/RewardsApi'
import type { MicrosoftRewardsBot } from '../src/index'

const delayConfig = getDefaultSearchDelayConfig()

function promotion(progress: number, complete = false): ApiPromotion {
    return {
        offerId: 'search-offer',
        name: 'search-offer',
        type: 'search',
        title: 'Search',
        complete,
        progress,
        max: 30,
        hidden: false,
        dailySetDate: '2026-08-04',
        classificationTag: 'PCSearch',
        destination: '',
        attributes: {}
    }
}

function pageStub(overrides: Record<string, unknown> = {}): Page {
    return {
        goto: async () => ({}) as never,
        waitForSelector: async () => null,
        waitForURL: async () => undefined,
        waitForLoadState: async () => undefined,
        waitForTimeout: async () => undefined,
        goBack: async () => null,
        $: async () => null,
        mouse: { wheel: async () => undefined } as never,
        keyboard: { press: async () => undefined, type: async () => undefined } as never,
        ...overrides
    } as unknown as Page
}

function runnerWithPromotions(
    sequence: Array<ApiPromotion | Error | undefined>,
    options: { page?: Page; isMobile?: boolean; searchDelay?: unknown; injectDelay?: boolean } = {}
): { runner: SearchRunner; waits: number[]; apiCalls: number[] } {
    const waits: number[] = []
    const apiCalls: number[] = []
    let cursor = 0
    const bot = {
        isMobile: options.isMobile ?? false,
        config: { searchSettings: { searchDelay: options.searchDelay ?? {
            desktop: { min: '25s', max: '60s' },
            mobile: { min: '20s', max: '45s' },
            longPauseProbability: 0.01,
            longPause: { min: '60s', max: '120s' },
            hardMax: '120s'
        } } },
        utils: {
            randomNumber: (min: number) => min,
            wait: async (duration: number) => { waits.push(duration) }
        },
        log: () => undefined
    } as unknown as MicrosoftRewardsBot
    const api = {
        getData: async () => {
            apiCalls.push(cursor)
            const current = sequence[Math.min(cursor++, sequence.length - 1)]
            if (current instanceof Error) throw current
            return { balance: 0, country: 'us', promotions: current ? [current] : [] }
        }
    } as unknown as RewardsApi
    const delay = new IntelligentDelaySystem(delayConfig, () => 0.5)
    const runner = new SearchRunner(
        bot,
        api,
        options.page ?? pageStub(),
        'test@example.com',
        options.injectDelay === false ? undefined : delay
    )
    return { runner, waits, apiCalls }
}

function testDelayBounds(): void {
    const normal = new IntelligentDelaySystem(delayConfig, () => 0.5)
    for (let i = 0; i < 100; i++) {
        const desktop = normal.calculateSearchDelay(i, false)
        const mobile = normal.calculateSearchDelay(i, true)
        assert(desktop >= 25_000 && desktop <= 60_000)
        assert(mobile >= 20_000 && mobile <= 45_000)
    }

    const longPause = new IntelligentDelaySystem(delayConfig, () => 0)
    assert.strictEqual(longPause.calculateSearchDelay(0, false), 60_000)
    assert(longPause.calculateSearchDelay(0, false) <= 120_000)
}

function testConfigNormalization(): void {
    const warnings: string[] = []
    const legacy = normalizeSearchDelayConfig({ min: '180s', max: '360s' }, message => warnings.push(message))
    assert.deepStrictEqual(legacy, delayConfig)
    assert.strictEqual(warnings.length, 1)
    assert.throws(() => normalizeSearchDelayConfig({
        desktop: { min: '60s', max: '25s' },
        mobile: { min: '20s', max: '45s' },
        longPauseProbability: 0.01,
        longPause: { min: '60s', max: '120s' },
        hardMax: '120s'
    }))
    assert.throws(() => normalizeSearchDelayConfig({
        min: '25s',
        max: '60s',
        desktop: { min: '25s', max: '60s' }
    }))
}

async function testProgressCadence(): Promise<void> {
    const normal = runnerWithPromotions([promotion(0), promotion(30)])
    const normalResult = await normal.runner.run()
    assert.strictEqual(normalResult.gained, 30)
    assert.strictEqual(normal.apiCalls.length, 2)
    assert.strictEqual(normal.waits.filter(duration => duration >= 20_000).length, 1)

    const completed = runnerWithPromotions([promotion(27), promotion(30)])
    await completed.runner.run()
    assert.strictEqual(completed.apiCalls.length, 2)
    assert.strictEqual(completed.waits.filter(duration => duration >= 20_000).length, 0)

    const flagged = runnerWithPromotions([promotion(27), promotion(27, true)])
    await flagged.runner.run()
    assert.strictEqual(flagged.apiCalls.length, 2)
    assert.strictEqual(flagged.waits.filter(duration => duration >= 20_000).length, 0)

    const stale = runnerWithPromotions([promotion(27), promotion(27)])
    await stale.runner.run()
    assert.strictEqual(stale.apiCalls.length, 5)
    assert.strictEqual(stale.waits.filter(duration => duration >= 20_000).length, 0)
    assert(stale.waits.includes(2_000) && stale.waits.includes(4_000) && stale.waits.includes(8_000))

    const configuredMobile = runnerWithPromotions([promotion(0), promotion(30)], {
        isMobile: true,
        injectDelay: false,
        searchDelay: {
            desktop: { min: '30s', max: '30s' },
            mobile: { min: '21s', max: '21s' },
            longPauseProbability: 0,
            longPause: { min: '60s', max: '120s' },
            hardMax: '120s'
        }
    })
    await configuredMobile.runner.run()
    assert.strictEqual(configuredMobile.waits.filter(duration => duration === 21_000).length, 1)

    const noNavigation = pageStub({
        waitForSelector: async () => ({ click: async () => undefined }),
        waitForURL: async () => { throw new Error('navigation failed') }
    })
    const failedBoxSearch = runnerWithPromotions([promotion(0), promotion(30)], { page: noNavigation })
    await failedBoxSearch.runner.run()
    assert.strictEqual(failedBoxSearch.apiCalls.length, 2)
    assert.strictEqual(failedBoxSearch.waits.filter(duration => duration >= 20_000).length, 0)

    const changedIdentity = { ...promotion(1), offerId: 'next-day-search' }
    const reset = runnerWithPromotions([promotion(0), changedIdentity])
    await reset.runner.run()
    assert.strictEqual(reset.apiCalls.length, 2)
    assert.strictEqual(reset.waits.filter(duration => duration >= 20_000).length, 1)

    const maxZero = runnerWithPromotions([{ ...promotion(0), max: 0 }])
    await maxZero.runner.run()
    assert.strictEqual(maxZero.apiCalls.length, 1)
    assert.strictEqual(maxZero.waits.filter(duration => duration >= 20_000).length, 0)

    const missing = runnerWithPromotions([undefined])
    await missing.runner.run()
    assert.strictEqual(missing.apiCalls.length, 1)

    const apiFailure = runnerWithPromotions([promotion(0), new Error('DAPI unavailable')])
    await apiFailure.runner.run()
    assert.strictEqual(apiFailure.apiCalls.length, 2)
    assert.strictEqual(apiFailure.waits.filter(duration => duration >= 20_000).length, 1)
}

async function main(): Promise<void> {
    testDelayBounds()
    testConfigNormalization()
    await testProgressCadence()
    console.log('search optimization tests passed')
}

void main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
