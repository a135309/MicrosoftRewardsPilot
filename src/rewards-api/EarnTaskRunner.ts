import type { Locator, Page, Response } from 'rebrowser-playwright'

import type { MicrosoftRewardsBot } from '../index'
import type { RewardsApi } from './RewardsApi'

export interface EarnTaskSnapshot {
    index: number
    href: string
    target: string
    text: string
    labelKey: string
    occurrence: number
    points: number | null
    completed: boolean
    disabled: boolean
    quest: boolean
}

export interface QuestProgress {
    current: number
    max: number
}

export interface EarnTaskRunResult {
    discovered: number
    attempted: number
    completed: number
    advanced: number
    skipped: number
    failed: number
    balanceBefore: number | null
    balanceAfter: number | null
    pointsGained: number | null
}

export interface EarnLinkInput {
    index: number
    href: string
    target: string
    text: string
    ariaLabel: string
    className: string
    disabled: boolean
    visible: boolean
}

interface QuestAction extends EarnLinkInput {
    key: string
}

const COMPLETED_MARKERS = new Set([
    'completed',
    'done',
    '\u5df2\u5b8c\u6210',
    '\u5b8c\u6210'
])

function textLines(value: string): string[] {
    return value
        .replace(/\u00a0/g, ' ')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
}

export function hasEarnCompletedMarker(value: string): boolean {
    return textLines(value).some(line => COMPLETED_MARKERS.has(line.toLowerCase()))
}

export function parseEarnPoints(value: string): number | null {
    const lines = textLines(value)
    const preferred = lines.find(line => /^\+\s*\d{1,5}(?:,\d{3})*$/.test(line))
    const fallback = hasEarnCompletedMarker(value)
        ? lines.find(line => /^\d{1,5}(?:,\d{3})*$/.test(line))
        : undefined
    const matched = preferred ?? fallback
    if (!matched) return null

    const parsed = Number(matched.replace(/[^\d]/g, ''))
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function makeEarnLabelKey(value: string): string {
    return textLines(value)
        .filter(line => !COMPLETED_MARKERS.has(line.toLowerCase()))
        .filter(line => !/^\+?\s*\d{1,5}(?:,\d{3})*$/.test(line))
        .filter(line => !/^\d+\s*\/\s*\d+(?:\s+tasks?)?$/i.test(line))
        .slice(0, 2)
        .join('\n')
}

export function parseQuestProgress(value: string): QuestProgress | null {
    const statusMatch = /(?:status|\u72b6\u6001)\s*[:\uFF1A]?\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i.exec(
        value.replace(/\s+/g, ' ')
    )
    if (!statusMatch?.[1] || !statusMatch[2]) return null

    const current = Number(statusMatch[1].replace(/,/g, ''))
    const max = Number(statusMatch[2].replace(/,/g, ''))
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(max) || current < 0 || max <= 0 || current > max) {
        return null
    }
    return { current, max }
}

export function isAutomatableEarnDestination(url: URL): boolean {
    if (!['http:', 'https:'].includes(url.protocol)) return false

    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase()
    if (host === 'rewards.bing.com' || host.endsWith('.rewards.bing.com')) {
        return path.startsWith('/earn/quest/')
    }
    if (host !== 'bing.com' && !host.endsWith('.bing.com')) return false
    if (path.startsWith('/search') || path.startsWith('/spotlight/imagepuzzle')) return true
    return false
}

export function isQuestActionLink(link: Pick<EarnLinkInput, 'ariaLabel' | 'className' | 'disabled' | 'visible'>): boolean {
    if (!link.visible || link.disabled) return false
    return link.className.includes('bg-bgCtrlBrandRest') || link.ariaLabel.includes(',')
}

export function buildEarnTaskSnapshots(links: readonly EarnLinkInput[], baseUrl: string): EarnTaskSnapshot[] {
    const occurrences = new Map<string, number>()

    return links.flatMap(link => {
        if (!link.visible) return []
        const points = parseEarnPoints(link.text)
        if (points === null) return []

        let url: URL
        try {
            url = new URL(link.href, baseUrl)
        } catch {
            return []
        }
        if (!isAutomatableEarnDestination(url)) return []

        const labelKey = makeEarnLabelKey(link.text)
        if (!labelKey) return []
        const identity = `${url.toString()}\u0000${labelKey}`
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)

        return [{
            index: link.index,
            href: url.toString(),
            target: link.target,
            text: link.text,
            labelKey,
            occurrence,
            points,
            completed: hasEarnCompletedMarker(link.text),
            disabled: link.disabled,
            quest: url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/earn/quest/')
        }]
    })
}

export class EarnTaskRunner {
    private static readonly LOAD_TIMEOUT_MS = 30_000
    private static readonly ACTION_RESPONSE_TIMEOUT_MS = 12_000
    private static readonly POPUP_TIMEOUT_MS = 6_000
    private static readonly MAX_QUEST_ACTIONS = 12

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page,
        private api?: RewardsApi
    ) {}

    private log(message: string, type: 'log' | 'warn' | 'error' = 'log', color?: 'green' | 'yellow'): void {
        this.bot.log(this.bot.isMobile, 'EARN-TASKS', message, type, color)
    }

    async run(): Promise<EarnTaskRunResult> {
        const result: EarnTaskRunResult = {
            discovered: 0,
            attempted: 0,
            completed: 0,
            advanced: 0,
            skipped: 0,
            failed: 0,
            balanceBefore: await this.readBalance(),
            balanceAfter: null,
            pointsGained: null
        }

        const earnUrl = new URL('/earn', this.bot.config.baseURL).toString()
        await this.openPage(earnUrl)
        const initialTasks = await this.discoverEarnTasks()
        result.discovered = initialTasks.length

        if (!initialTasks.length) {
            this.log('No positive-point Earn cards found')
            return this.finishResult(result)
        }

        this.log(`Discovered ${initialTasks.length} positive-point Earn cards`)

        for (const initialTask of initialTasks) {
            try {
                await this.openPage(earnUrl)
                const task = await this.findCurrentTask(initialTask)
                if (!task || task.completed || task.disabled) {
                    result.skipped++
                    continue
                }

                if (task.quest) {
                    const questResult = await this.runQuest(task)
                    result.attempted += questResult.attempted
                    result.completed += questResult.completed
                    result.advanced += questResult.advanced
                    result.skipped += questResult.skipped
                    result.failed += questResult.failed
                } else {
                    result.attempted++
                    const completed = await this.runEarnCard(task, earnUrl)
                    if (completed) {
                        result.completed++
                    } else {
                        result.failed++
                    }
                }
            } catch (error) {
                result.failed++
                this.log(`Card failed: ${initialTask.labelKey.replace(/\n/g, ' / ')} (${error})`, 'warn')
            }

            await this.bot.utils.wait(this.bot.utils.randomNumber(2_000, 6_000))
        }

        return this.finishResult(result)
    }

    private async finishResult(result: EarnTaskRunResult): Promise<EarnTaskRunResult> {
        result.balanceAfter = await this.readBalance()
        if (result.balanceBefore !== null && result.balanceAfter !== null) {
            result.pointsGained = result.balanceAfter - result.balanceBefore
        }
        this.log(
            `Done: discovered ${result.discovered}, attempted ${result.attempted}, ` +
            `completed ${result.completed}, advanced ${result.advanced}, skipped ${result.skipped}, failed ${result.failed}`,
            result.failed > 0 ? 'warn' : 'log',
            result.failed > 0 ? 'yellow' : 'green'
        )
        return result
    }

    private async runEarnCard(task: EarnTaskSnapshot, earnUrl: string): Promise<boolean> {
        const locator = await this.locateTask(task)
        if (!locator) return false

        this.log(`Clicking card: ${task.labelKey.replace(/\n/g, ' / ')} (+${task.points})`)
        await this.clickAction(locator)
        await this.openPage(earnUrl)

        const updated = await this.findCurrentTask(task)
        const completed = Boolean(updated?.completed)
        if (completed) {
            this.log(`Completed card: ${task.labelKey.replace(/\n/g, ' / ')}`, 'log', 'green')
        } else {
            this.log(`Card did not expose a completed DOM state: ${task.labelKey.replace(/\n/g, ' / ')}`, 'warn')
        }
        return completed
    }

    private async runQuest(task: EarnTaskSnapshot): Promise<Pick<EarnTaskRunResult, 'attempted' | 'completed' | 'advanced' | 'skipped' | 'failed'>> {
        const summary = { attempted: 0, completed: 0, advanced: 0, skipped: 0, failed: 0 }
        const locator = await this.locateTask(task)
        if (!locator) {
            summary.skipped++
            return summary
        }

        await locator.click()
        await this.waitForPageReady()
        const questUrl = this.page.url()
        if (!new URL(questUrl).pathname.startsWith('/earn/quest/')) {
            this.log(`Quest card did not open a quest page: ${task.labelKey.replace(/\n/g, ' / ')}`, 'warn')
            summary.failed++
            return summary
        }

        let progress = await this.readQuestProgress()
        const attemptedActions = new Set<string>()

        for (let actionIndex = 0; actionIndex < EarnTaskRunner.MAX_QUEST_ACTIONS; actionIndex++) {
            const actions = await this.discoverQuestActions()
            const action = actions.find(candidate => !attemptedActions.has(candidate.key))
            if (!action) break

            attemptedActions.add(action.key)
            summary.attempted++
            const before = progress
            const actionLocator = this.page.locator('a[href]').nth(action.index)
            this.log(`Clicking quest action: ${action.text || action.ariaLabel}`)

            try {
                await this.clickAction(actionLocator)
                await this.openPage(questUrl)
                progress = await this.readQuestProgress()

                if (before && progress && progress.current > before.current) {
                    summary.completed++
                    summary.advanced++
                    this.log(`Quest advanced ${before.current}/${before.max} -> ${progress.current}/${progress.max}`, 'log', 'green')
                } else {
                    const remaining = await this.discoverQuestActions()
                    if (!remaining.some(candidate => candidate.key === action.key)) {
                        summary.completed++
                    } else {
                        summary.failed++
                        this.log(`Quest action did not advance: ${action.text || action.ariaLabel}`, 'warn')
                    }
                }
            } catch (error) {
                summary.failed++
                this.log(`Quest action failed: ${action.text || action.ariaLabel} (${error})`, 'warn')
                await this.openPage(questUrl).catch(() => undefined)
            }

            if (progress && progress.current >= progress.max) break
            await this.bot.utils.wait(this.bot.utils.randomNumber(2_000, 5_000))
        }

        if (summary.attempted === 0) {
            summary.skipped++
            this.log(`Quest has no enabled actions; locked or complete: ${task.labelKey.replace(/\n/g, ' / ')}`)
        }
        return summary
    }

    private async clickAction(locator: Locator): Promise<void> {
        const actionResponse = this.waitForEarnActionResponse()
        const popupPromise = this.page.waitForEvent('popup', {
            timeout: EarnTaskRunner.POPUP_TIMEOUT_MS
        }).catch(() => null)

        await locator.click()
        const [response, popup] = await Promise.all([actionResponse, popupPromise])
        if (response && (response.status() < 200 || response.status() >= 300)) {
            this.log(`Earn action returned HTTP ${response.status()}`, 'warn')
        }

        if (popup) {
            await popup.waitForLoadState('domcontentloaded', {
                timeout: EarnTaskRunner.LOAD_TIMEOUT_MS
            }).catch(() => undefined)
            await this.bot.utils.wait(2_000)
            await popup.close().catch(() => undefined)
        } else {
            await this.waitForPageReady()
        }

        await this.bot.utils.wait(1_500)
    }

    private waitForEarnActionResponse(): Promise<Response | null> {
        const expectedOrigin = new URL(this.bot.config.baseURL).origin
        return this.page.waitForResponse(response => {
            try {
                const url = new URL(response.url())
                return response.request().method() === 'POST' &&
                    url.origin === expectedOrigin &&
                    url.pathname.startsWith('/earn')
            } catch {
                return false
            }
        }, { timeout: EarnTaskRunner.ACTION_RESPONSE_TIMEOUT_MS }).catch(() => null)
    }

    private async discoverEarnTasks(): Promise<EarnTaskSnapshot[]> {
        const links = await this.readLinks()
        return buildEarnTaskSnapshots(links, this.bot.config.baseURL)
    }

    private async findCurrentTask(task: EarnTaskSnapshot): Promise<EarnTaskSnapshot | null> {
        const tasks = await this.discoverEarnTasks()
        return tasks.find(candidate =>
            candidate.href === task.href &&
            candidate.labelKey === task.labelKey &&
            candidate.occurrence === task.occurrence
        ) ?? null
    }

    private async locateTask(task: EarnTaskSnapshot): Promise<Locator | null> {
        const current = await this.findCurrentTask(task)
        return current ? this.page.locator('a[href]').nth(current.index) : null
    }

    private async discoverQuestActions(): Promise<QuestAction[]> {
        const links = await this.readLinks()
        return links
            .filter(isQuestActionLink)
            .map(link => ({
                ...link,
                key: `${link.href}\u0000${link.ariaLabel || link.text}`
            }))
    }

    private async readLinks(): Promise<EarnLinkInput[]> {
        return await this.page.locator('a[href]').evaluateAll(nodes => nodes.map((node, index) => {
            const anchor = node as HTMLAnchorElement
            const style = getComputedStyle(anchor)
            const rect = anchor.getBoundingClientRect()
            const className = typeof anchor.className === 'string' ? anchor.className : ''
            return {
                index,
                href: anchor.href,
                target: anchor.target,
                text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim(),
                ariaLabel: anchor.getAttribute('aria-label') || '',
                className,
                disabled: anchor.getAttribute('aria-disabled') === 'true' ||
                    anchor.hasAttribute('disabled') ||
                    anchor.hasAttribute('data-disabled') ||
                    /(?:^|\s)(?:disabled|cursor-default)(?:\s|$)/.test(className),
                visible: style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0
            }
        })) as EarnLinkInput[]
    }

    private async readQuestProgress(): Promise<QuestProgress | null> {
        const text = await this.page.locator('body').innerText().catch(() => '')
        return parseQuestProgress(text)
    }

    private async openPage(url: string): Promise<void> {
        await this.page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: EarnTaskRunner.LOAD_TIMEOUT_MS
        })
        await this.waitForPageReady()
    }

    private async waitForPageReady(): Promise<void> {
        await this.page.waitForLoadState('domcontentloaded', {
            timeout: EarnTaskRunner.LOAD_TIMEOUT_MS
        }).catch(() => undefined)
        await this.page.locator('body').waitFor({
            state: 'visible',
            timeout: EarnTaskRunner.LOAD_TIMEOUT_MS
        })
        await this.bot.utils.wait(1_000)
    }

    private async readBalance(): Promise<number | null> {
        if (!this.api) return null
        try {
            return (await this.api.getData()).balance
        } catch (error) {
            this.log(`Balance verification failed: ${error}`, 'warn')
            return null
        }
    }
}
