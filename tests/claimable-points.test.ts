import assert from 'assert'

import {
    CLAIM_POINTS_COPY,
    getClaimCardAccessibleNamePattern,
    getClaimPointsLocaleCandidates,
    isClaimVerified,
    normalizeClaimPointsLocale,
    parseStandalonePoints
} from '../src/rewards-api/ClaimablePointsRunner'
import { ClaimablePointsRunner } from '../src/rewards-api/ClaimablePointsRunner'
import { GeoLanguageDetector } from '../utils/GeoLanguage'

function testLocales(): void {
    assert.strictEqual(normalizeClaimPointsLocale('zh-CN'), 'zh-CN')
    assert.strictEqual(normalizeClaimPointsLocale('zh-Hans'), 'zh-CN')
    assert.strictEqual(normalizeClaimPointsLocale('en-US'), 'en')
    assert.strictEqual(normalizeClaimPointsLocale(''), 'en')

    assert.strictEqual(CLAIM_POINTS_COPY['zh-CN'].cardTitle, '可领取')
    assert.strictEqual(CLAIM_POINTS_COPY.en.cardTitle, 'Ready to claim')
    assert.strictEqual(CLAIM_POINTS_COPY.en.pending, 'Pending')
    assert.strictEqual(CLAIM_POINTS_COPY.en.claimButton, 'Claim points')

    assert.deepStrictEqual(getClaimPointsLocaleCandidates('zh-CN', 'en-US'), ['zh-CN', 'en'])
    assert.deepStrictEqual(getClaimPointsLocaleCandidates('en-US', 'zh-Hans'), ['en', 'zh-CN'])
    assert.deepStrictEqual(getClaimPointsLocaleCandidates('ja-JP'), ['en', 'zh-CN'])
    assert.deepStrictEqual(getClaimPointsLocaleCandidates(), ['en', 'zh-CN'])
}

function testCardAccessibleNames(): void {
    const zhPattern = getClaimCardAccessibleNamePattern(CLAIM_POINTS_COPY['zh-CN'])
    const enPattern = getClaimCardAccessibleNamePattern(CLAIM_POINTS_COPY.en)

    assert.strictEqual(zhPattern.test('可领取 可领取 495 领取'), true)
    assert.strictEqual(zhPattern.test('可领取 495 领取'), true)
    assert.strictEqual(zhPattern.test('领取积分'), false)
    assert.strictEqual(enPattern.test('Ready to claim Ready to claim 1,234 Claim'), true)
    assert.strictEqual(enPattern.test('Ready to claim 495 Claim'), true)
    assert.strictEqual(enPattern.test('Claim points'), false)
}

function testPointParsing(): void {
    assert.strictEqual(parseStandalonePoints(['Ready to claim', '447', 'Claim']), 447)
    assert.strictEqual(parseStandalonePoints(['可领取', '2,647', '领取']), 2647)
    assert.strictEqual(parseStandalonePoints(['Points', '2 647', 'Pending']), 2647)
    assert.strictEqual(parseStandalonePoints(['Points', '0']), 0)
    assert.strictEqual(parseStandalonePoints(['Pending', 'Claim points']), null)
    assert.strictEqual(parseStandalonePoints(['12.5']), null)
}

function testVerification(): void {
    assert.strictEqual(isClaimVerified(447, 0, 2650, 3097), true)
    assert.strictEqual(isClaimVerified(447, 1, 2650, 3097), false)
    assert.strictEqual(isClaimVerified(447, 0, 2650, 3096), false)
    assert.strictEqual(isClaimVerified(0, 0, 2650, 2650), false)
}

async function testDirectGeoLookup(): Promise<void> {
    const original = GeoLanguageDetector.getCurrentLocation
    let argumentCount = -1
    GeoLanguageDetector.getCurrentLocation = (async (...args: unknown[]) => {
        argumentCount = args.length
        return {
            country: 'United States',
            countryCode: 'US',
            city: 'Test',
            timezone: 'America/New_York',
            language: 'en',
            currency: 'USD',
            ip: '127.0.0.1',
            latitude: 0,
            longitude: 0
        }
    }) as typeof GeoLanguageDetector.getCurrentLocation

    try {
        const runner = new ClaimablePointsRunner(
            { log: () => undefined, isMobile: false } as never,
            {} as never,
            { evaluate: async () => 'en-US' } as never
        )
        await (runner as unknown as { getLocaleCandidates(): Promise<unknown> }).getLocaleCandidates()
        assert.strictEqual(argumentCount, 0)
    } finally {
        GeoLanguageDetector.getCurrentLocation = original
    }
}

async function main(): Promise<void> {
    testLocales()
    testCardAccessibleNames()
    testPointParsing()
    testVerification()
    await testDirectGeoLookup()
    console.log('claimable points tests passed')
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
