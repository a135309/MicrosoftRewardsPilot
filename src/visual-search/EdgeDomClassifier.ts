import { Locator, Page } from 'rebrowser-playwright'

export type EdgeDomStatus = 'absent' | 'inactive' | 'in_progress' | 'complete' | 'unknown'

export interface EdgeDomClassification {
    status: EdgeDomStatus
    language: string
    progress?: number
    max?: number
    reason?: string
}

export interface EdgeProgressSnapshot {
    label: string
    text: string
    current: number | null
    max: number | null
}

export interface EdgeDomSnapshot {
    language: string
    rendered: boolean
    progressBars: EdgeProgressSnapshot[]
    inactiveCard: boolean
    inactiveFlyout: boolean
}

const EDGE_TITLE_PATTERN = /(?:^|\s)(?:Microsoft\s+)?Edge(?:\s|$)/i
const EDGE_LABEL_PATTERN = /^(?:Microsoft\s+)?Edge$/i
const MINUTES_PATTERN = /(?:分钟|Minutes)\s*:\s*(\d+)\s*\/\s*30/i
const INACTIVE_CARD_PATTERN = /如何激活|How to activate/i
const INACTIVE_FLYOUT_PATTERN = /激活连续打卡|Activate streak/i
const DASHBOARD_URL = 'https://rewards.bing.com/dashboard'

export function classifyEdgeDomSnapshot(snapshot: EdgeDomSnapshot): EdgeDomClassification {
    for (const progressBar of snapshot.progressBars) {
        const labelMatches = EDGE_LABEL_PATTERN.test(progressBar.label.trim())
        const textMatches = EDGE_TITLE_PATTERN.test(progressBar.text) && MINUTES_PATTERN.test(progressBar.text)
        if (!labelMatches && !textMatches) continue
        if (progressBar.current === null || progressBar.max !== 30 || progressBar.current < 0) continue

        return {
            status: progressBar.current >= progressBar.max ? 'complete' : 'in_progress',
            language: snapshot.language,
            progress: Math.min(progressBar.current, progressBar.max),
            max: progressBar.max
        }
    }

    if (snapshot.inactiveCard && snapshot.inactiveFlyout) {
        return { status: 'inactive', language: snapshot.language }
    }
    if (snapshot.inactiveCard || snapshot.inactiveFlyout) {
        return {
            status: 'unknown',
            language: snapshot.language,
            reason: 'Edge activation state was not double-confirmed'
        }
    }
    if (!snapshot.rendered) {
        return { status: 'unknown', language: snapshot.language, reason: 'Dashboard main content was not stable' }
    }
    return { status: 'absent', language: snapshot.language }
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
    const count = await locator.count()
    for (let index = 0; index < count; index++) {
        const item = locator.nth(index)
        if (await item.isVisible().catch(() => false)) return item
    }
    return null
}

export class EdgeDomClassifier {
    constructor(private page: Page, private wait: (milliseconds: number) => Promise<void>) {}

    async classify(): Promise<EdgeDomClassification> {
        try {
            if (!this.isDashboardUrl(this.page.url())) {
                await this.page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
                await this.wait(1500)
            }

            await this.page.keyboard.press('Escape').catch(() => null)
            const language = await this.page.evaluate(() => document.documentElement.lang || '').catch(() => '')

            for (let step = 0; step < 8; step++) {
                await this.page.evaluate((scrollStep) => {
                    window.scrollTo({
                        top: Math.min(document.body.scrollHeight, scrollStep * window.innerHeight * 0.75),
                        behavior: 'smooth'
                    })
                }, step)
                await this.wait(300)

                const progressBars = await this.readProgressBars()
                const progressResult = classifyEdgeDomSnapshot({
                    language,
                    rendered: true,
                    progressBars,
                    inactiveCard: false,
                    inactiveFlyout: false
                })
                if (progressResult.status === 'in_progress' || progressResult.status === 'complete') {
                    return progressResult
                }

                const inactiveCard = await this.findInactiveCard()
                if (inactiveCard) {
                    await inactiveCard.click().catch(() => null)
                    await this.wait(500)
                    const inactiveFlyout = Boolean(await firstVisible(
                        this.page.locator('button').filter({ hasText: INACTIVE_FLYOUT_PATTERN })
                    ))
                    return classifyEdgeDomSnapshot({
                        language,
                        rendered: true,
                        progressBars,
                        inactiveCard: true,
                        inactiveFlyout
                    })
                }
            }

            const rendered = await this.page.evaluate(() => {
                const main = document.querySelector('main, [role="main"]')
                return Boolean(main && (main.textContent ?? '').trim().length > 100)
            }).catch(() => false)

            return classifyEdgeDomSnapshot({
                language,
                rendered,
                progressBars: [],
                inactiveCard: false,
                inactiveFlyout: false
            })
        } catch (error) {
            return {
                status: 'unknown',
                language: '',
                reason: error instanceof Error ? error.message : String(error)
            }
        }
    }

    private async readProgressBars(): Promise<EdgeProgressSnapshot[]> {
        return this.page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="progressbar"]'))
            .filter(element => {
                const rect = element.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0
            })
            .map(element => {
                const container = element.closest<HTMLElement>('button, [role="button"], article, li') ?? element.parentElement
                const text = (container?.innerText || container?.textContent || '').trim()
                const currentValue = element.getAttribute('aria-valuenow')
                const maxValue = element.getAttribute('aria-valuemax')
                const current = currentValue === null ? null : Number(currentValue)
                const max = maxValue === null ? null : Number(maxValue)
                return {
                    label: element.getAttribute('aria-label') || '',
                    text,
                    current: current !== null && Number.isFinite(current) ? current : null,
                    max: max !== null && Number.isFinite(max) ? max : null
                }
            }))
    }

    private async findInactiveCard(): Promise<Locator | null> {
        const buttons = this.page.locator('button').filter({ hasText: INACTIVE_CARD_PATTERN })
        const count = await buttons.count()
        for (let index = 0; index < count; index++) {
            const button = buttons.nth(index)
            if (!(await button.isVisible().catch(() => false))) continue
            const context = await button.evaluate(element => {
                let current: Element | null = element
                let text = ''
                for (let depth = 0; current && depth < 4; depth++, current = current.parentElement) {
                    text = `${text} ${current.textContent ?? ''}`
                }
                return text
            }).catch(() => '')
            if (EDGE_TITLE_PATTERN.test(context)) return button
        }
        return null
    }

    private isDashboardUrl(value: string): boolean {
        try {
            const url = new URL(value)
            return url.hostname.endsWith('rewards.bing.com') && url.pathname.startsWith('/dashboard')
        } catch {
            return false
        }
    }
}
