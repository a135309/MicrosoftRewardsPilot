import assert from 'assert'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import { OAuth } from '../interfaces/OAuth'
import { runParallelFinalPhases } from '../src/FinalPhaseCoordinator'
import { EdgeBrowsingClient } from '../src/rewards-api/EdgeBrowsingClient'
import {
    EdgeBrowsingPool,
    DEFAULT_EDGE_BROWSING_CONFIG,
    resolveEdgeBrowsingConfig,
    validateEdgeBrowsingConfig
} from '../src/rewards-api/EdgeBrowsingPool'
import { EdgeBrowsingStateStore } from '../src/rewards-api/EdgeBrowsingState'
import { classifyEdgeDomSnapshot, EdgeDomClassification } from '../src/visual-search/EdgeDomClassifier'

const token: OAuth = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    scope: 'scope',
    expires_in: 3600,
    ext_expires_in: 3600,
    foci: '1',
    token_type: 'Bearer'
}

function testConfig(): void {
    assert.deepStrictEqual(resolveEdgeBrowsingConfig(), DEFAULT_EDGE_BROWSING_CONFIG)
    const resolved = resolveEdgeBrowsingConfig({ intervalSec: 10, finalConcurrency: 4, startJitterSec: { min: 0, max: 0 } })
    assert.strictEqual(resolved.intervalSec, 305)
    assert.strictEqual(resolved.finalConcurrency, 4)
    assert.deepStrictEqual(resolved.startJitterSec, { min: 0, max: 0 })
    assert.deepStrictEqual(validateEdgeBrowsingConfig(undefined), [])
    assert.ok(validateEdgeBrowsingConfig({ intervalSec: 304 }).length > 0)
    assert.ok(validateEdgeBrowsingConfig({ startJitterSec: { min: 5, max: 2 } }).length > 0)
}

function testDomClassification(): void {
    const zh = classifyEdgeDomSnapshot({
        language: 'zh-Hans',
        rendered: true,
        progressBars: [{ label: 'Microsoft Edge', text: 'Microsoft Edge 分钟: 5/30', current: 5, max: 30 }],
        inactiveCard: false,
        inactiveFlyout: false
    })
    assert.deepStrictEqual(zh, { status: 'in_progress', language: 'zh-Hans', progress: 5, max: 30 })

    const en = classifyEdgeDomSnapshot({
        language: 'en',
        rendered: true,
        progressBars: [{ label: 'Edge', text: 'Edge Minutes: 30/30', current: 30, max: 30 }],
        inactiveCard: false,
        inactiveFlyout: false
    })
    assert.strictEqual(en.status, 'complete')

    const inactive = classifyEdgeDomSnapshot({
        language: 'zh-Hans',
        rendered: true,
        progressBars: [],
        inactiveCard: true,
        inactiveFlyout: true
    })
    assert.strictEqual(inactive.status, 'inactive')

    const achievement = classifyEdgeDomSnapshot({
        language: 'en',
        rendered: true,
        progressBars: [{ label: 'Achievement', text: '22 / 30', current: 22, max: 30 }],
        inactiveCard: false,
        inactiveFlyout: false
    })
    assert.strictEqual(achievement.status, 'absent')
}

async function testClientContract(): Promise<void> {
    const requests: Array<Record<string, unknown>> = []
    const client = new EdgeBrowsingClient('secret', async config => {
        requests.push(config as Record<string, unknown>)
        if (config.method === 'GET') {
            return {
                data: {
                    response: {
                        promotions: [{
                            name: 'edge_browsing_streak_flight',
                            attributes: {
                                offerid: 'DailyCheckIn_Edge',
                                progress: '5',
                                max: '30',
                                report_per_minutes: '5',
                                complete: 'false'
                            }
                        }]
                    }
                }
            } as never
        }
        return { data: { response: { activity: { p: 5 }, balance: 100, isDuplicate: false } } } as never
    }, 'CN', 'zh-CN')

    const status = await client.getStatus()
    assert.deepStrictEqual(status, { found: true, complete: false, progress: 5, max: 30, reportPerMinutes: 5 })
    const report = await client.reportActivity()
    assert.deepStrictEqual(report, { points: 5, balance: 100, duplicate: false })

    const getRequest = requests[0] as { url: string; headers: Record<string, string> }
    assert.strictEqual(getRequest.url, 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=edge')
    assert.strictEqual(getRequest.headers['X-Rewards-PartnerId'], 'EdgeHub')
    assert.strictEqual(getRequest.headers['X-Rewards-AppId'], 'EdgeDesktop')

    const postRequest = requests[1] as { data: unknown }
    assert.deepStrictEqual(postRequest.data, {
        amount: 1,
        attributes: { offerid: 'DailyCheckIn_Edge' },
        request_user_info: true,
        type: '29'
    })
}

async function testStateReset(): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-state-'))
    try {
        let now = new Date(2026, 7, 7, 1, 0, 0)
        const store = new EdgeBrowsingStateStore(directory, () => now)
        await store.update('account@example.com', state => ({ ...state, attemptsToday: 3, runStatus: 'waiting' }))
        assert.strictEqual((await store.read('account@example.com')).attemptsToday, 3)

        now = new Date(2026, 7, 8, 1, 0, 0)
        const reset = await store.read('account@example.com')
        assert.strictEqual(reset.attemptsToday, 0)
        assert.strictEqual(reset.date, '2026-08-08')
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition')
        await new Promise<void>(resolve => setImmediate(resolve))
    }
}

async function testPoolConcurrency(): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-pool-'))
    let nowMs = new Date(2026, 7, 7, 2, 0, 0).getTime()
    let releaseFirstStatus!: () => void
    const firstStatusGate = new Promise<void>(resolve => { releaseFirstStatus = resolve })
    const started: string[] = []

    try {
        const pool = new EdgeBrowsingPool({
            config: {
                finalConcurrency: 3,
                intervalSec: 305,
                maxAttemptsPerDay: 6,
                targetMinutes: 30,
                drainTimeoutMin: 90,
                startJitterSec: { min: 0, max: 0 }
            },
            sessionPath: directory,
            requestFactory: () => async () => ({ data: {} }) as never,
            clientFactory: enrollment => {
                started.push(enrollment.email)
                let reported = false
                let firstStatus = true
                return {
                    getStatus: async () => {
                        if (firstStatus) {
                            firstStatus = false
                            await firstStatusGate
                        }
                        return { found: true, complete: reported, progress: reported ? 30 : 0, max: 30, reportPerMinutes: 5 }
                    },
                    reportActivity: async () => {
                        reported = true
                        return { points: 5, balance: 100, duplicate: false }
                    }
                }
            },
            now: () => new Date(nowMs),
            wait: async milliseconds => {
                if (milliseconds >= 1000) nowMs += milliseconds
                await new Promise<void>(resolve => setImmediate(resolve))
            },
            random: () => 0,
            log: () => undefined
        })

        const dom: EdgeDomClassification = { status: 'in_progress', language: 'en', progress: 0, max: 30 }
        for (let index = 0; index < 4; index++) {
            const email = `account-${index}@example.com`
            await pool.recordClassification(email, dom)
            await pool.enroll({ email, token, dom })
        }

        const drain = pool.drain()
        await waitFor(() => started.length === 3)
        assert.strictEqual(started.length, 3)
        releaseFirstStatus()
        const summary = await drain
        assert.strictEqual(started.length, 4)
        assert.deepStrictEqual(summary, { completed: 4, waiting: 0, capped: 0, inactive: 0, absent: 0, failed: 0 })
    } finally {
        releaseFirstStatus?.()
        await fs.rm(directory, { recursive: true, force: true })
    }
}

async function testPoolCadenceAndCap(): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-cadence-'))
    let nowMs = new Date(2026, 7, 7, 3, 0, 0).getTime()
    const reportTimes: number[] = []

    try {
        const store = new EdgeBrowsingStateStore(directory, () => new Date(nowMs))
        const pool = new EdgeBrowsingPool({
            config: {
                finalConcurrency: 1,
                intervalSec: 305,
                maxAttemptsPerDay: 6,
                targetMinutes: 30,
                drainTimeoutMin: 90,
                startJitterSec: { min: 0, max: 0 }
            },
            sessionPath: directory,
            stateStore: store,
            requestFactory: () => async () => ({ data: {} }) as never,
            clientFactory: () => ({
                getStatus: async () => ({ found: true, complete: false, progress: 0, max: 120, reportPerMinutes: 5 }),
                reportActivity: async () => {
                    reportTimes.push(nowMs)
                    return { points: 0, balance: 100, duplicate: false }
                }
            }),
            now: () => new Date(nowMs),
            wait: async milliseconds => {
                if (milliseconds >= 1000) nowMs += milliseconds
                await new Promise<void>(resolve => setImmediate(resolve))
            },
            random: () => 0,
            log: () => undefined
        })

        const email = 'cadence@example.com'
        const dom: EdgeDomClassification = { status: 'in_progress', language: 'zh-Hans', progress: 0, max: 30 }
        await pool.recordClassification(email, dom)
        await pool.enroll({ email, token, dom })
        const summary = await pool.drain()

        assert.strictEqual(reportTimes.length, 6)
        for (let index = 1; index < reportTimes.length; index++) {
            assert.ok(reportTimes[index]! - reportTimes[index - 1]! >= 305_000)
        }
        assert.strictEqual(summary.capped, 1)
        const state = await store.read(email)
        assert.strictEqual(state.attemptsToday, 6)
        assert.strictEqual(state.runStatus, 'capped')
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}

async function testDrainTimeoutPersistsWaiting(): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edge-timeout-'))
    let nowMs = new Date(2026, 7, 7, 4, 0, 0).getTime()

    try {
        const store = new EdgeBrowsingStateStore(directory, () => new Date(nowMs))
        const pool = new EdgeBrowsingPool({
            config: {
                finalConcurrency: 1,
                intervalSec: 305,
                maxAttemptsPerDay: 6,
                targetMinutes: 30,
                drainTimeoutMin: 1,
                startJitterSec: { min: 0, max: 0 }
            },
            sessionPath: directory,
            stateStore: store,
            requestFactory: () => async () => ({ data: {} }) as never,
            clientFactory: () => ({
                getStatus: async () => ({ found: true, complete: false, progress: 0, max: 120, reportPerMinutes: 5 }),
                reportActivity: async () => ({ points: 0, balance: 100, duplicate: false })
            }),
            now: () => new Date(nowMs),
            wait: async milliseconds => {
                if (milliseconds >= 1000) nowMs += milliseconds
                await new Promise<void>(resolve => setImmediate(resolve))
            },
            random: () => 0,
            log: () => undefined
        })

        const email = 'timeout@example.com'
        const dom: EdgeDomClassification = { status: 'in_progress', language: 'en', progress: 0, max: 30 }
        await pool.recordClassification(email, dom)
        await pool.enroll({ email, token, dom })
        const summary = await pool.drain()
        const state = await store.read(email)

        assert.strictEqual(summary.waiting, 1)
        assert.strictEqual(state.runStatus, 'waiting')
        assert.strictEqual(state.attemptsToday, 1)
        assert.ok(state.nextDueAt)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
}

async function testParallelFinalPhasesWithoutCandidates(): Promise<void> {
    let resolveEdge!: () => void
    const edgeGate = new Promise<void>(resolve => { resolveEdge = resolve })
    let visualStarted = false

    const phases = runParallelFinalPhases(
        async () => {
            await edgeGate
            return 'edge-complete'
        },
        async () => {
            visualStarted = true
            return [] as string[]
        },
        () => 'edge-fallback',
        () => ['visual-fallback']
    )

    await waitFor(() => visualStarted)
    resolveEdge()
    const result = await phases
    assert.strictEqual(result.edge, 'edge-complete')
    assert.deepStrictEqual(result.visual, [])
}

async function testParallelFinalPhasesStartTogether(): Promise<void> {
    let resolveEdge!: () => void
    let resolveVisual!: () => void
    const edgeGate = new Promise<void>(resolve => { resolveEdge = resolve })
    const visualGate = new Promise<void>(resolve => { resolveVisual = resolve })
    let edgeStarted = false
    let visualStarted = false
    let settled = false

    const phases = runParallelFinalPhases(
        async () => {
            edgeStarted = true
            await edgeGate
            return 'edge'
        },
        async () => {
            visualStarted = true
            await visualGate
            return 'visual'
        },
        () => 'edge-fallback',
        () => 'visual-fallback'
    ).finally(() => { settled = true })

    await waitFor(() => edgeStarted && visualStarted)
    resolveVisual()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.strictEqual(settled, false)
    resolveEdge()
    const result = await phases
    assert.deepStrictEqual({ edge: result.edge, visual: result.visual }, { edge: 'edge', visual: 'visual' })
}

async function testParallelFinalPhaseFailureIsolation(): Promise<void> {
    let visualCompleted = false
    const result = await runParallelFinalPhases(
        async () => { throw new Error('drain failed') },
        async () => {
            await new Promise<void>(resolve => setImmediate(resolve))
            visualCompleted = true
            return 'visual-complete'
        },
        () => 'edge-fallback',
        () => 'visual-fallback'
    )

    assert.strictEqual(visualCompleted, true)
    assert.strictEqual(result.edge, 'edge-fallback')
    assert.strictEqual(result.visual, 'visual-complete')
    assert.ok(result.edgeError instanceof Error)
    assert.strictEqual(result.visualError, undefined)
}

async function main(): Promise<void> {
    testConfig()
    testDomClassification()
    await testClientContract()
    await testStateReset()
    await testPoolConcurrency()
    await testPoolCadenceAndCap()
    await testDrainTimeoutPersistsWaiting()
    await testParallelFinalPhasesWithoutCandidates()
    await testParallelFinalPhasesStartTogether()
    await testParallelFinalPhaseFailureIsolation()
    console.log('Edge browsing tests passed')
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
