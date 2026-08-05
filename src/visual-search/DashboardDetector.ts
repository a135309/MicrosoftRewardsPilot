import { Locator, Page } from 'rebrowser-playwright'

import {
    VisualSearchCandidate,
    VisualSearchProgress,
    VisualSearchScreeningResult,
    isVisualSearchComplete
} from './types'

const CARD_SELECTOR = 'button:has(img[src*="search_visual.svg"])'
const TASK_LINK_SELECTOR = 'a[href*="vsstreak"][href*="vstooltip"]'

export function parseProgress(current: string | null, max: string | null): VisualSearchProgress | null {
    if (current === null || max === null || current.trim() === '' || max.trim() === '') return null

    const parsedCurrent = Number(current)
    const parsedMax = Number(max)
    if (!Number.isFinite(parsedCurrent) || !Number.isFinite(parsedMax) || parsedCurrent < 0 || parsedMax <= 0) {
        return null
    }

    return { current: parsedCurrent, max: parsedMax }
}

export function validateVisualSearchTaskUrl(value: string): string | null {
    try {
        const url = new URL(value)
        const host = url.hostname.toLowerCase()
        if (url.protocol !== 'https:' || (host !== 'bing.com' && !host.endsWith('.bing.com'))) return null

        const features = (url.searchParams.get('features') ?? '')
            .split(',')
            .map(feature => feature.trim().toLowerCase())
        if (!features.includes('vsstreak') || !features.includes('vstooltip')) return null

        return url.href
    } catch {
        return null
    }
}

export function classifyDashboardCard(
    cardPresent: boolean,
    rendered: boolean,
    progress: VisualSearchProgress | null
): 'absent' | 'already_complete' | 'candidate' | 'uncertain' {
    if (!rendered) return 'uncertain'
    if (!cardPresent) return 'absent'
    if (!progress) return 'uncertain'
    return progress.current >= progress.max ? 'already_complete' : 'candidate'
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
    const count = await locator.count()
    for (let index = 0; index < count; index++) {
        const item = locator.nth(index)
        if (await item.isVisible().catch(() => false)) return item
    }
    return null
}

async function readProgress(container: Locator): Promise<VisualSearchProgress | null> {
    const progress = container.locator('[role="progressbar"]').first()
    if (!(await progress.count())) return null
    return parseProgress(
        await progress.getAttribute('aria-valuenow'),
        await progress.getAttribute('aria-valuemax')
    )
}

async function readDrawerProgress(link: Locator): Promise<VisualSearchProgress | null> {
    return link.evaluate((element) => {
        let current: Element | null = element
        for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
            const progress = current.querySelector('[role="progressbar"]')
            if (!progress) continue
            const now = progress.getAttribute('aria-valuenow')
            const max = progress.getAttribute('aria-valuemax')
            if (now === null || max === null) return null
            return { current: Number(now), max: Number(max) }
        }
        return null
    }).then(value => value && Number.isFinite(value.current) && Number.isFinite(value.max) && value.max > 0
        ? value
        : null)
}

export class DashboardDetector {
    constructor(private page: Page, private wait: (milliseconds: number) => Promise<void>) {}

    async screen(email: string): Promise<VisualSearchScreeningResult> {
        try {
            await this.page.goto('https://rewards.bing.com/dashboard', {
                waitUntil: 'domcontentloaded',
                timeout: 60_000
            })
            await this.wait(1500)

            const language = await this.page.evaluate(() => document.documentElement.lang || '').catch(() => '')
            const currentUrl = new URL(this.page.url())
            if (!currentUrl.hostname.endsWith('rewards.bing.com') || /signin|login|welcome/i.test(currentUrl.pathname)) {
                return { status: 'uncertain', language, reason: `Unexpected dashboard URL: ${currentUrl.pathname}` }
            }

            for (let step = 0; step < 6; step++) {
                await this.page.evaluate((scrollStep) => {
                    window.scrollTo({ top: Math.min(document.body.scrollHeight, (scrollStep + 1) * window.innerHeight * 0.75), behavior: 'smooth' })
                }, step)
                await this.wait(350)
            }

            const card = await firstVisible(this.page.locator(CARD_SELECTOR))
            if (!card) {
                const rendered = await this.page.evaluate(() => {
                    const main = document.querySelector('main, [role="main"]')
                    return Boolean(main && (main.textContent ?? '').trim().length > 100)
                }).catch(() => false)
                const status = classifyDashboardCard(false, rendered, null)
                return status === 'absent'
                    ? { status, language }
                    : { status, language, reason: 'Dashboard did not render stable main content' }
            }

            const cardProgress = await readProgress(card)
            if (!cardProgress) return { status: 'uncertain', language, reason: 'Visible card has no valid progressbar' }
            const cardStatus = classifyDashboardCard(true, true, cardProgress)
            if (cardStatus === 'already_complete') return { status: cardStatus, language }

            await card.click()
            await this.wait(500)

            const link = await firstVisible(this.page.locator(TASK_LINK_SELECTOR))
            if (!link) return { status: 'uncertain', language, reason: 'Visual Search drawer link missing' }

            const taskUrl = validateVisualSearchTaskUrl(await link.getAttribute('href') ?? '')
            const drawerProgress = await readDrawerProgress(link)
            if (!taskUrl || !drawerProgress) {
                return { status: 'uncertain', language, reason: 'Visual Search drawer data invalid' }
            }

            const candidate: VisualSearchCandidate = {
                email,
                taskUrl,
                language,
                cardBefore: cardProgress,
                drawerBefore: drawerProgress
            }
            return { status: 'candidate', language, candidate }
        } catch (error) {
            return {
                status: 'uncertain',
                language: '',
                reason: error instanceof Error ? error.message : String(error)
            }
        }
    }

    async verifyCompletion(candidate: VisualSearchCandidate, timeoutMs: number): Promise<{
        completed: boolean
        cardAfter?: VisualSearchProgress
        drawerAfter?: VisualSearchProgress
    }> {
        const deadline = Date.now() + timeoutMs
        let lastCard: VisualSearchProgress | undefined
        let lastDrawer: VisualSearchProgress | undefined

        do {
            await this.page.goto('https://rewards.bing.com/dashboard', {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(60_000, Math.max(1_000, timeoutMs))
            }).catch(() => null)
            await this.wait(1000)

            for (let step = 0; step < 6; step++) {
                await this.page.evaluate((scrollStep) => window.scrollTo(0, (scrollStep + 1) * window.innerHeight * 0.75), step).catch(() => null)
                await this.wait(250)
            }

            const card = await firstVisible(this.page.locator(CARD_SELECTOR))
            if (card) {
                lastCard = await readProgress(card) ?? undefined
                await card.click().catch(() => null)
                await this.wait(400)
                const link = await firstVisible(this.page.locator(TASK_LINK_SELECTOR))
                if (link) lastDrawer = await readDrawerProgress(link) ?? undefined
            }

            if (lastCard && lastDrawer && isVisualSearchComplete(
                candidate.cardBefore,
                candidate.drawerBefore,
                lastCard,
                lastDrawer
            )) {
                return { completed: true, cardAfter: lastCard, drawerAfter: lastDrawer }
            }

            await this.wait(3000)
        } while (Date.now() < deadline)

        return { completed: false, cardAfter: lastCard, drawerAfter: lastDrawer }
    }
}
