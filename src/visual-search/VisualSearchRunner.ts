import { Locator, Page } from 'rebrowser-playwright'

import { DashboardDetector } from './DashboardDetector'
import { VisualSearchCandidate, VisualSearchResult } from './types'

export interface VisualSearchRunnerOptions {
    taskTimeoutMs: number
    completionTimeoutMs: number
    wait: (milliseconds: number) => Promise<void>
    log: (message: string, type?: 'log' | 'warn') => void
    ensureLogin?: () => Promise<void>
}

export function isVisualResultUrl(value: string): boolean {
    try {
        const url = new URL(value)
        const host = url.hostname.toLowerCase()
        return url.protocol === 'https:' && (host === 'bing.com' || host.endsWith('.bing.com')) &&
            url.pathname.toLowerCase().includes('/search') &&
            url.searchParams.get('FORM')?.toUpperCase() === 'SBIHMP' &&
            Boolean(url.searchParams.get('bcid'))
    } catch {
        return false
    }
}

export class VisualSearchRunner {
    private readonly detector: DashboardDetector

    constructor(private page: Page, private options: VisualSearchRunnerOptions) {
        this.detector = new DashboardDetector(page, options.wait)
    }

    async run(candidate: VisualSearchCandidate, imagePath: string): Promise<VisualSearchResult> {
        try {
            await this.openTask(candidate.taskUrl)
            await this.waitForControl()
            await this.openDialog()
            await this.uploadImage(imagePath)
            if (!(await this.waitForResult())) {
                this.options.log('Result transition not observed; checking Dashboard completion', 'warn')
            }

            const verification = await this.detector.verifyCompletion(candidate, this.options.completionTimeoutMs)
            return {
                email: candidate.email,
                status: verification.completed ? 'completed' : 'unconfirmed',
                reason: verification.completed ? undefined : 'Dashboard card and drawer did not both advance to max',
                cardAfter: verification.cardAfter,
                drawerAfter: verification.drawerAfter
            }
        } catch (error) {
            return {
                email: candidate.email,
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error)
            }
        }
    }

    private async openTask(taskUrl: string): Promise<void> {
        await this.page.goto(taskUrl, { waitUntil: 'domcontentloaded', timeout: this.options.taskTimeoutMs })
        const url = new URL(this.page.url())
        if (/login\.live\.com$/i.test(url.hostname) || /signin|login|welcome/i.test(url.pathname)) {
            if (!this.options.ensureLogin) throw new Error('Visual Search session is not authenticated')
            await this.options.ensureLogin()
            await this.page.goto(taskUrl, { waitUntil: 'domcontentloaded', timeout: this.options.taskTimeoutMs })
        }
    }

    private async waitForControl(): Promise<void> {
        await this.page.locator('#sbi_b').waitFor({ state: 'visible', timeout: this.options.taskTimeoutMs })
        await this.findTrigger()
    }

    private async openDialog(): Promise<void> {
        const trigger = await this.findTrigger()
        const dialog = this.page.locator('#sb_sbidialog[shdlg]').first()

        await trigger.click()
        let opened = await dialog.waitFor({
            state: 'visible',
            timeout: Math.min(3_000, this.options.taskTimeoutMs)
        }).then(() => true).catch(() => false)

        if (!opened) {
            const hint = this.page.locator('.shtip').first()
            if (await hint.isVisible().catch(() => false)) {
                await hint.click().catch(() => null)
                await this.options.wait(250)
                opened = await dialog.isVisible().catch(() => false)
            }
        }

        if (!opened) {
            await trigger.click()
            await dialog.waitFor({ state: 'visible', timeout: this.options.taskTimeoutMs })
        }
        const expanded = await this.page.locator('#sb_sbi[aria-expanded="true"]').count()
        if (!expanded) throw new Error('Visual Search dialog opened without expanded state')
    }

    private async uploadImage(imagePath: string): Promise<void> {
        const browse = this.page.locator('#sb_sbidialog[shdlg] #sb_brtext').first()
        const input = this.page.locator('#sb_sbidialog[shdlg] #sb_fileinput[type="file"]').first()
        await browse.waitFor({ state: 'visible', timeout: this.options.taskTimeoutMs })

        const chooserPromise = this.page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null)
        await browse.click()
        const chooser = await chooserPromise
        if (chooser) {
            await chooser.setFiles(imagePath)
            return
        }

        if (!(await input.count())) throw new Error('Visual Search file input missing')
        await input.setInputFiles(imagePath)
    }

    private async waitForResult(): Promise<boolean> {
        const deadline = Date.now() + Math.min(this.options.taskTimeoutMs, 30_000)
        while (Date.now() < deadline) {
            if (isVisualResultUrl(this.page.url())) return true
            const resultDom = await this.page.locator('[data-bm="visual-search"], .imgpt, #vs_results').count().catch(() => 0)
            if (resultDom > 0) return true
            await this.options.wait(500)
        }
        return false
    }

    private async findTrigger(): Promise<Locator> {
        for (const selector of ['#sb_sbip', '#sb_sbi[role="button"]', '[role="button"]:has(#sbi_b)']) {
            const locator = this.page.locator(selector).first()
            if (await locator.isVisible().catch(() => false)) return locator
        }
        throw new Error('Visual Search control is not visible')
    }
}
