import { Locator, Page } from 'rebrowser-playwright'
import fs from 'fs'
import path from 'path'

import { DashboardDetector } from './DashboardDetector'
import { VisualSearchCandidate, VisualSearchResult } from './types'

export interface VisualSearchRunnerOptions {
    taskTimeoutMs: number
    completionTimeoutMs: number
    wait: (milliseconds: number) => Promise<void>
    log: (message: string, type?: 'log' | 'warn') => void
    ensureLogin?: () => Promise<void>
    manualUploadPause?: {
        resumeFile: string
        timeoutMs: number
    }
}

export interface VisualSearchManualPause {
    resumeFile: string
    timeoutMs: number
}

export function resolveVisualSearchManualPause(
    environment: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd()
): VisualSearchManualPause | undefined {
    if (environment.VISUAL_SEARCH_MANUAL_PAUSE?.trim() !== '1') return undefined

    const rawTimeout = environment.VISUAL_SEARCH_MANUAL_PAUSE_TIMEOUT_MS?.trim() || '900000'
    const timeoutMs = Number(rawTimeout)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000) {
        throw new Error('VISUAL_SEARCH_MANUAL_PAUSE_TIMEOUT_MS must be an integer >= 30000')
    }

    const configuredFile = environment.VISUAL_SEARCH_MANUAL_RESUME_FILE?.trim()
    return {
        resumeFile: path.resolve(cwd, configuredFile || '.visual-search-manual-resume'),
        timeoutMs
    }
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
            if (this.options.manualUploadPause) {
                await this.waitForManualDialog(this.options.manualUploadPause)
            } else {
                await this.waitForControl()
                await this.openDialog()
            }
            const attributionPromise = this.waitForAttribution()
            await this.uploadImage(imagePath)
            if (!(await this.waitForResult())) {
                this.options.log('Result page did not appear before timeout; Dashboard verification skipped', 'warn')
                return {
                    email: candidate.email,
                    status: 'unconfirmed',
                    reason: 'Visual Search result page did not appear before timeout'
                }
            }

            if (await attributionPromise) {
                this.options.log('Visual Search Rewards attribution request completed')
            } else {
                this.options.log('Visual Search Rewards attribution request was not observed', 'warn')
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

    private async waitForManualDialog(pause: VisualSearchManualPause): Promise<void> {
        if (fs.existsSync(pause.resumeFile)) {
            throw new Error(`Manual Visual Search resume marker already exists: ${pause.resumeFile}`)
        }

        this.options.log(`Manual Visual Search pause ready; popup URL: ${this.page.url()}`)
        const deadline = Date.now() + pause.timeoutMs
        let detected = false

        while (Date.now() < deadline) {
            const state = await this.page.evaluate(() => {
                const dialog = document.querySelector('#sb_sbidialog[shdlg]') as HTMLElement | null
                const expanded = document.querySelector('#sb_sbi[aria-expanded="true"]')
                if (!dialog || !expanded) return { dialogVisible: false, expanded: false }
                const style = getComputedStyle(dialog)
                const rect = dialog.getBoundingClientRect()
                return {
                    dialogVisible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
                    expanded: true
                }
            }).catch(() => ({ dialogVisible: false, expanded: false }))

            if (state.dialogVisible && state.expanded) {
                detected = true
                this.options.log('Manual Visual Search dialog detected; capture DOM/network now, then create resume marker')
                break
            }
            await this.options.wait(500)
        }

        if (!detected) throw new Error('Manual Visual Search dialog was not opened before timeout')

        while (Date.now() < deadline) {
            if (fs.existsSync(pause.resumeFile)) {
                fs.unlinkSync(pause.resumeFile)
                this.options.log('Manual Visual Search resume marker detected; continuing upload')
                return
            }
            await this.options.wait(500)
        }

        throw new Error('Manual Visual Search resume marker was not created before timeout')
    }

    private async openTask(taskUrl: string): Promise<void> {
        try {
            this.page = await this.detector.openTaskPopup(taskUrl, this.options.taskTimeoutMs)
        } catch (error) {
            if (!(error instanceof Error) || error.message !== 'Visual Search session is not authenticated') throw error
            if (!this.options.ensureLogin) throw error
            await this.options.ensureLogin()
            this.page = await this.detector.openTaskPopup(taskUrl, this.options.taskTimeoutMs)
        }
    }

    private async waitForAttribution(): Promise<boolean> {
        const timeout = Math.min(30_000, Math.max(1_000, this.options.taskTimeoutMs))
        return this.page.waitForResponse(response => {
            try {
                const url = new URL(response.url())
                const host = url.hostname.toLowerCase()
                return (host === 'bing.com' || host.endsWith('.bing.com')) &&
                    url.pathname.toLowerCase() === '/rewardsapp/reportactivity' &&
                    response.status() >= 200 && response.status() < 300
            } catch {
                return false
            }
        }, { timeout }).then(() => true).catch(() => false)
    }

    private async waitForControl(): Promise<void> {
        const deadline = Date.now() + this.options.taskTimeoutMs
        while (Date.now() < deadline) {
            if (await this.findTrigger()) return
            await this.options.wait(250)
        }
        throw new Error('Visual Search control is not visible')
    }

    private async openDialog(): Promise<void> {
        const trigger = await this.findTrigger()
        if (!trigger) throw new Error('Visual Search control is not visible')
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
        const deadline = Date.now() + this.options.taskTimeoutMs
        while (Date.now() < deadline) {
            if (isVisualResultUrl(this.page.url())) {
                const remaining = Math.max(1_000, deadline - Date.now())
                await this.page.waitForLoadState('domcontentloaded', { timeout: remaining }).catch(() => null)
                let rendered = false
                while (Date.now() < deadline) {
                    rendered = await this.page.evaluate(() => {
                        const body = document.body
                        return document.readyState !== 'loading' &&
                            Boolean(body && body.innerText.trim().length > 100 && body.querySelector('img'))
                    }).catch(() => false)
                    if (rendered) break
                    await this.options.wait(500)
                }
                if (!rendered) return false

                await this.page.waitForLoadState('networkidle', {
                    timeout: Math.min(30_000, Math.max(1_000, deadline - Date.now()))
                }).catch(() => null)
                await this.options.wait(Math.min(10_000, Math.max(0, deadline - Date.now())))
                this.options.log('Visual Search result page rendered; starting Dashboard verification')
                return true
            }
            await this.options.wait(500)
        }
        return false
    }

    private async findTrigger(): Promise<Locator | null> {
        for (const selector of [
            '#sb_cam_island[role="button"]',
            '#sb_sbip',
            '#sb_sbi[role="button"]',
            '[role="button"]:has(#sbi_b)'
        ]) {
            const locator = this.page.locator(selector).first()
            if (await locator.isVisible().catch(() => false)) return locator
        }
        return null
    }
}
