import type { Locator, Page } from 'rebrowser-playwright'

import type { AccountProxy } from '../../interfaces/Account'
import { GeoLanguageDetector } from '../../utils/GeoLanguage'
import type { MicrosoftRewardsBot } from '../index'
import type { RewardsApi } from './RewardsApi'

export type ClaimPointsLocale = 'zh-CN' | 'en'
export type ClaimPointsStatus = 'claimed' | 'none' | 'unverified' | 'skipped'

export interface ClaimPointsCopy {
    cardTitle: string
    cardAction: string
    dialogTitle: string
    pointsAlt: string
    pending: string
    claimButton: string
    empty: string
    earnMore: string
}

export interface ClaimPointsResult {
    status: ClaimPointsStatus
    expectedPoints: number
    actualGained: number | null
    remainingPoints: number | null
}

export const CLAIM_POINTS_COPY: Record<ClaimPointsLocale, ClaimPointsCopy> = {
    'zh-CN': {
        cardTitle: '可领取',
        cardAction: '领取',
        dialogTitle: '领取积分',
        pointsAlt: '积分',
        pending: '待领取',
        claimButton: '领取积分',
        empty: '当前没有要领取的积分',
        earnMore: '赚取更多积分'
    },
    en: {
        cardTitle: 'Ready to claim',
        cardAction: 'Claim',
        dialogTitle: 'Claim points',
        pointsAlt: 'Points',
        pending: 'Pending',
        claimButton: 'Claim points',
        empty: 'No points to claim right now',
        earnMore: 'Earn more points'
    }
}

export function normalizeClaimPointsLocale(language?: string | null): ClaimPointsLocale {
    return language && /^zh(?:[-_]|$)/i.test(language.trim()) ? 'zh-CN' : 'en'
}

export function getClaimPointsLocaleCandidates(...languages: Array<string | null | undefined>): ClaimPointsLocale[] {
    const locales: ClaimPointsLocale[] = []
    const add = (locale: ClaimPointsLocale): void => {
        if (!locales.includes(locale)) locales.push(locale)
    }

    for (const language of languages) {
        if (language) add(normalizeClaimPointsLocale(language))
    }

    add('en')
    add('zh-CN')
    return locales
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function getClaimCardAccessibleNamePattern(copy: ClaimPointsCopy): RegExp {
    const title = escapeRegExp(copy.cardTitle)
    const action = escapeRegExp(copy.cardAction)
    return new RegExp(`^${title}(?:\\s+${title})?\\s+[\\d,\\s\\u00a0]+\\s+${action}$`, 'i')
}

export function parseStandalonePoints(values: readonly string[]): number | null {
    for (const raw of values) {
        const value = raw.replace(/\u00a0/g, ' ').trim()
        if (!/^\d+$/.test(value) && !/^\d{1,3}(?:[,\s]\d{3})+$/.test(value)) {
            continue
        }

        const parsed = Number(value.replace(/[^\d]/g, ''))
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
            return parsed
        }
    }
    return null
}

export function isClaimVerified(
    expectedPoints: number,
    remainingPoints: number | null,
    balanceBefore: number,
    balanceAfter: number
): boolean {
    return expectedPoints > 0 && remainingPoints === 0 && balanceAfter - balanceBefore === expectedPoints
}

interface DashboardCardMatch {
    card: Locator
    copy: ClaimPointsCopy
}

interface PostClaimDomState {
    verified: boolean
    remainingPoints: number | null
}

export class ClaimablePointsRunner {
    private static readonly DASHBOARD_TIMEOUT_MS = 20_000
    private static readonly DIALOG_TIMEOUT_MS = 10_000
    private static readonly DASHBOARD_RESPONSE_TIMEOUT_MS = 10_000
    private static readonly DOM_VERIFY_ATTEMPTS = 10
    private static readonly DOM_VERIFY_STABLE_READS = 2
    private static readonly BALANCE_VERIFY_ATTEMPTS = 5

    constructor(
        private bot: MicrosoftRewardsBot,
        private api: RewardsApi,
        private page: Page,
        private proxy?: AccountProxy
    ) {}

    private log(message: string, type: 'log' | 'warn' | 'error' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'CLAIM-POINTS', message, type, color)
    }

    async run(): Promise<ClaimPointsResult> {
        try {
            const dashboardUrl = new URL('/dashboard?ref=rewardspanel', this.bot.config.baseURL).toString()
            await this.page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })

            const locales = await this.getLocaleCandidates()
            const cardMatch = await this.waitForDashboardCard(locales)
            if (!cardMatch) {
                return this.skip('领取积分页面未找到')
            }

            const expectedPoints = await this.readDashboardPoints(cardMatch.card)
            if (expectedPoints === null) {
                return this.skip('领取积分数值解析失败')
            }
            if (expectedPoints === 0) {
                this.log('无可领取积分')
                return { status: 'none', expectedPoints: 0, actualGained: 0, remainingPoints: 0 }
            }

            await cardMatch.card.click()
            const dialog = await this.waitForDialog(cardMatch.copy)
            if (!dialog) {
                return this.skip('领取积分侧栏未打开', expectedPoints)
            }

            const sidebarPoints = await this.readPendingPoints(dialog, cardMatch.copy)
            const pending = dialog.getByText(cardMatch.copy.pending, { exact: true }).first()
            const claimButton = dialog.getByRole('button', { name: cardMatch.copy.claimButton, exact: true }).first()
            const pendingVisible = await this.isVisible(pending)
            const claimVisible = await this.isVisible(claimButton)
            const claimEnabled = claimVisible && await claimButton.isEnabled().catch(() => false)

            if (sidebarPoints !== expectedPoints || !pendingVisible || !claimEnabled) {
                await this.bot.utils.wait(1_500)
                const retryPoints = await this.readPendingPoints(dialog, cardMatch.copy)
                const retryPending = await this.isVisible(pending)
                const retryVisible = await this.isVisible(claimButton)
                const retryEnabled = retryVisible && await claimButton.isEnabled().catch(() => false)
                if (retryPoints !== expectedPoints || !retryPending || !retryEnabled) {
                    return this.skip(
                        `领取积分侧栏状态不一致：卡片 ${expectedPoints}，侧栏 ${retryPoints ?? '未知'}`,
                        expectedPoints
                    )
                }
            }

            const balanceBefore = (await this.api.getData()).balance

            // Click exactly once. Every subsequent step only reads state.
            const claimResponse = this.waitForDashboardResponse('POST')
            const refreshResponse = this.waitForDashboardResponse('GET')
            await claimButton.click()
            const [claimStatus, refreshStatus] = await Promise.all([claimResponse, refreshResponse])
            this.logDashboardResponse('领取请求', claimStatus)
            this.logDashboardResponse('领取刷新', refreshStatus)

            const domState = await this.waitForClaimedDom(locales, cardMatch.copy)
            const balanceAfter = await this.waitForBalance(expectedPoints, balanceBefore)
            const actualGained = balanceAfter === null ? null : balanceAfter - balanceBefore

            if (balanceAfter !== null && domState.verified && isClaimVerified(
                expectedPoints,
                domState.remainingPoints,
                balanceBefore,
                balanceAfter
            )) {
                this.log(`已领取积分：${actualGained}`, 'log', 'green')
                return {
                    status: 'claimed',
                    expectedPoints,
                    actualGained,
                    remainingPoints: domState.remainingPoints
                }
            }

            this.log(
                `领取积分校验异常：页面可领取 ${expectedPoints}，` +
                `接口新增 ${actualGained ?? '未知'}，页面剩余 ${domState.remainingPoints ?? '未知'}`,
                'warn'
            )
            return {
                status: 'unverified',
                expectedPoints,
                actualGained,
                remainingPoints: domState.remainingPoints
            }
        } catch (error) {
            return this.skip(`领取积分模块失败：${error}`)
        }
    }

    private skip(message: string, expectedPoints = 0): ClaimPointsResult {
        this.log(message, 'warn')
        return { status: 'skipped', expectedPoints, actualGained: null, remainingPoints: null }
    }

    private async getLocaleCandidates(): Promise<ClaimPointsLocale[]> {
        const pageLanguage = await this.page.evaluate(() => document.documentElement.lang || navigator.language || '')
            .catch(() => '')
        let geoLanguage = ''

        try {
            const location = await GeoLanguageDetector.getCurrentLocation(this.proxy)
            geoLanguage = location.language
        } catch (error) {
            this.log(`页面语言地理检测失败：${error}`, 'warn')
        }

        return getClaimPointsLocaleCandidates(pageLanguage, geoLanguage)
    }

    private dashboardCard(copy: ClaimPointsCopy): Locator {
        const byAccessibleName = this.page.getByRole('button', {
            name: getClaimCardAccessibleNamePattern(copy)
        })
        const byImage = this.page
            .getByRole('button')
            .filter({ has: this.page.locator(`img[alt="${copy.cardTitle}"]`) })
            .filter({ hasText: copy.cardAction })
        return byAccessibleName.or(byImage)
    }

    private async getSingleVisible(locator: Locator, label: string): Promise<Locator | null> {
        const count = await locator.count().catch(() => 0)
        let match: Locator | null = null

        for (let index = 0; index < count; index++) {
            const candidate = locator.nth(index)
            if (!await this.isVisible(candidate)) continue
            if (match) {
                this.log(`${label}匹配到多个可见元素，停止操作`, 'warn')
                return null
            }
            match = candidate
        }

        return match
    }

    private async locateDashboardCard(locales: readonly ClaimPointsLocale[]): Promise<DashboardCardMatch | null> {
        for (const locale of locales) {
            const copy = CLAIM_POINTS_COPY[locale]
            const card = await this.getSingleVisible(this.dashboardCard(copy), `${copy.cardTitle}卡片`)
            if (card) return { card, copy }
        }
        return null
    }

    private async waitForDashboardCard(locales: readonly ClaimPointsLocale[]): Promise<DashboardCardMatch | null> {
        const deadline = Date.now() + ClaimablePointsRunner.DASHBOARD_TIMEOUT_MS
        while (Date.now() < deadline) {
            const match = await this.locateDashboardCard(locales)
            if (match) return match
            await this.bot.utils.wait(500)
        }
        return null
    }

    private async readDashboardPoints(card: Locator): Promise<number | null> {
        return this.readStandalonePoints(card)
    }

    private async locateDialog(copy: ClaimPointsCopy): Promise<Locator | null> {
        const namedDialog = await this.getSingleVisible(
            this.page.getByRole('dialog', { name: copy.dialogTitle, exact: true }),
            `${copy.dialogTitle}侧栏`
        )
        if (namedDialog) return namedDialog

        const roleFallback = await this.getSingleVisible(
            this.page.locator('[role="dialog"]').filter({ hasText: copy.dialogTitle }),
            `${copy.dialogTitle}侧栏`
        )
        if (roleFallback) return roleFallback

        const heading = await this.getSingleVisible(
            this.page.getByRole('heading', { name: copy.dialogTitle, exact: true }),
            `${copy.dialogTitle}标题`
        )
        if (!heading) return null

        let container = heading.locator('xpath=..')
        for (let depth = 0; depth < 6; depth++) {
            const hasClaimButton = await this.isVisible(
                container.getByRole('button', { name: copy.claimButton, exact: true }).first()
            )
            const hasPending = await this.isVisible(container.getByText(copy.pending, { exact: true }).first())
            const hasEmpty = await this.isVisible(container.getByText(copy.empty, { exact: true }).first())
            const hasEarnMore = await this.isVisible(
                container.getByRole('link', { name: copy.earnMore, exact: true }).first()
            )
            if (hasClaimButton || hasPending || hasEmpty || hasEarnMore) return container
            container = container.locator('xpath=..')
        }

        return null
    }

    private async waitForDialog(copy: ClaimPointsCopy): Promise<Locator | null> {
        const deadline = Date.now() + ClaimablePointsRunner.DIALOG_TIMEOUT_MS
        while (Date.now() < deadline) {
            const dialog = await this.locateDialog(copy)
            if (dialog) return dialog
            await this.bot.utils.wait(250)
        }
        return null
    }

    private async readPendingPoints(dialog: Locator, copy: ClaimPointsCopy): Promise<number | null> {
        const pending = dialog.getByText(copy.pending, { exact: true }).first()
        if (!await this.isVisible(pending)) return null
        return this.readPointsNear(pending)
    }

    private async readDialogPoints(dialog: Locator, copy: ClaimPointsCopy): Promise<number | null> {
        const pointsImage = dialog.locator(`img[alt="${copy.pointsAlt}"]`).first()
        if (!await this.isVisible(pointsImage)) return null
        return this.readPointsNear(pointsImage)
    }

    private async readPointsNear(anchor: Locator): Promise<number | null> {
        let container = anchor.locator('xpath=..')
        for (let depth = 0; depth < 3; depth++) {
            const points = await this.readStandalonePoints(container)
            if (points !== null) return points
            container = container.locator('xpath=..')
        }
        return null
    }

    private async readStandalonePoints(container: Locator): Promise<number | null> {
        const paragraphs = await container.locator('p').allTextContents().catch(() => [])
        const paragraphPoints = parseStandalonePoints(paragraphs)
        if (paragraphPoints !== null) return paragraphPoints

        const leafTexts = await container.locator('xpath=.//*[not(*)]').allTextContents().catch(() => [])
        return parseStandalonePoints(leafTexts)
    }

    private async waitForClaimedDom(
        locales: readonly ClaimPointsLocale[],
        copy: ClaimPointsCopy
    ): Promise<PostClaimDomState> {
        let remainingPoints: number | null = null
        let stableReads = 0

        for (let attempt = 0; attempt < ClaimablePointsRunner.DOM_VERIFY_ATTEMPTS; attempt++) {
            const cardMatch = await this.locateDashboardCard(locales)
            remainingPoints = cardMatch ? await this.readDashboardPoints(cardMatch.card) : null

            const dialog = await this.locateDialog(copy)
            let verified = !dialog && remainingPoints === 0

            if (dialog) {
                const dialogPoints = await this.readDialogPoints(dialog, copy)
                const pendingVisible = await this.isVisible(dialog.getByText(copy.pending, { exact: true }).first())
                const claimVisible = await this.isVisible(
                    dialog.getByRole('button', { name: copy.claimButton, exact: true }).first()
                )
                const emptyVisible = await this.isVisible(dialog.getByText(copy.empty, { exact: true }).first())
                const earnMoreVisible = await this.isVisible(
                    dialog.getByRole('link', { name: copy.earnMore, exact: true }).first()
                )

                verified = (
                    remainingPoints === 0 &&
                    dialogPoints === 0 &&
                    !pendingVisible &&
                    !claimVisible &&
                    (emptyVisible || earnMoreVisible)
                )
            }

            stableReads = verified ? stableReads + 1 : 0
            if (stableReads >= ClaimablePointsRunner.DOM_VERIFY_STABLE_READS) {
                return { verified: true, remainingPoints }
            }

            if (attempt < ClaimablePointsRunner.DOM_VERIFY_ATTEMPTS - 1) {
                await this.bot.utils.wait(1_000)
            }
        }

        return { verified: false, remainingPoints }
    }

    private async waitForDashboardResponse(method: 'GET' | 'POST'): Promise<number | null> {
        const expectedOrigin = new URL(this.page.url()).origin
        return this.page.waitForResponse(response => {
            try {
                const url = new URL(response.url())
                return response.request().method() === method &&
                    url.origin === expectedOrigin &&
                    url.pathname === '/dashboard'
            } catch {
                return false
            }
        }, { timeout: ClaimablePointsRunner.DASHBOARD_RESPONSE_TIMEOUT_MS })
            .then(response => response.status())
            .catch(() => null)
    }

    private logDashboardResponse(label: string, status: number | null): void {
        if (status === null) {
            this.log(`${label}未捕获，继续使用页面和积分接口校验`, 'warn')
        } else if (status < 200 || status >= 300) {
            this.log(`${label}返回 HTTP ${status}`, 'warn')
        }
    }

    private async waitForBalance(expectedPoints: number, balanceBefore: number): Promise<number | null> {
        let lastBalance: number | null = null
        for (let attempt = 0; attempt < ClaimablePointsRunner.BALANCE_VERIFY_ATTEMPTS; attempt++) {
            try {
                lastBalance = (await this.api.getData()).balance
                if (lastBalance - balanceBefore === expectedPoints) return lastBalance
            } catch (error) {
                this.log(`领取积分接口校验失败：${error}`, 'warn')
            }

            if (attempt < ClaimablePointsRunner.BALANCE_VERIFY_ATTEMPTS - 1) {
                await this.bot.utils.wait(2_000)
            }
        }
        return lastBalance
    }

    private async isVisible(locator: Locator): Promise<boolean> {
        return locator.isVisible().catch(() => false)
    }
}
