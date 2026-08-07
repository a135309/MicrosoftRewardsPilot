import type { AxiosRequestConfig, AxiosResponse } from 'axios'

import type { ConfigEdgeBrowsing } from '../../interfaces/Config'
import type { OAuth } from '../../interfaces/OAuth'
import type { EdgeDomClassification } from '../visual-search/EdgeDomClassifier'
import { EdgeBrowsingClient, EdgeBrowsingClientLike, EdgeBrowsingStatus } from './EdgeBrowsingClient'
import { EdgeBrowsingRunStatus, EdgeBrowsingState, EdgeBrowsingStateStore } from './EdgeBrowsingState'

export interface EdgeBrowsingSummary {
    completed: number
    waiting: number
    capped: number
    inactive: number
    absent: number
    failed: number
}

export interface EdgeBrowsingEnrollment {
    email: string
    token: OAuth
    dom: EdgeDomClassification
}

export interface EdgeBrowsingPoolOptions {
    config?: Partial<ConfigEdgeBrowsing>
    sessionPath: string
    requestFactory: (email: string) => (config: AxiosRequestConfig) => Promise<AxiosResponse>
    log: (message: string, type?: 'log' | 'warn' | 'error') => void
    now?: () => Date
    wait?: (milliseconds: number) => Promise<void>
    random?: () => number
    clientFactory?: (enrollment: EdgeBrowsingEnrollment) => EdgeBrowsingClientLike
    stateStore?: EdgeBrowsingStateStore
}

interface QueueEntry extends EdgeBrowsingEnrollment {
    domProgress: number
    domMax: number
}

export const DEFAULT_EDGE_BROWSING_CONFIG: ConfigEdgeBrowsing = {
    finalConcurrency: 3,
    intervalSec: 305,
    maxAttemptsPerDay: 6,
    targetMinutes: 30,
    drainTimeoutMin: 90,
    startJitterSec: { min: 2, max: 5 }
}

export function resolveEdgeBrowsingConfig(config?: Partial<ConfigEdgeBrowsing>): ConfigEdgeBrowsing {
    const jitter = { ...DEFAULT_EDGE_BROWSING_CONFIG.startJitterSec, ...config?.startJitterSec }
    const minJitter = Math.max(0, Number(jitter.min) || 0)
    const maxJitter = Math.max(minJitter, Number(jitter.max) || minJitter)
    return {
        finalConcurrency: Math.max(1, Math.floor(Number(config?.finalConcurrency) || DEFAULT_EDGE_BROWSING_CONFIG.finalConcurrency)),
        intervalSec: Math.max(305, Math.floor(Number(config?.intervalSec) || DEFAULT_EDGE_BROWSING_CONFIG.intervalSec)),
        maxAttemptsPerDay: Math.max(1, Math.floor(Number(config?.maxAttemptsPerDay) || DEFAULT_EDGE_BROWSING_CONFIG.maxAttemptsPerDay)),
        targetMinutes: Math.max(1, Math.floor(Number(config?.targetMinutes) || DEFAULT_EDGE_BROWSING_CONFIG.targetMinutes)),
        drainTimeoutMin: Math.max(1, Number(config?.drainTimeoutMin) || DEFAULT_EDGE_BROWSING_CONFIG.drainTimeoutMin),
        startJitterSec: { min: minJitter, max: maxJitter }
    }
}

export function validateEdgeBrowsingConfig(config: unknown): string[] {
    if (config === undefined) return []
    if (!config || typeof config !== 'object' || Array.isArray(config)) return ['edgeBrowsing must be an object']

    const value = config as Record<string, unknown>
    const issues: string[] = []
    const positiveIntegers = ['finalConcurrency', 'maxAttemptsPerDay', 'targetMinutes', 'drainTimeoutMin'] as const
    for (const key of positiveIntegers) {
        const candidate = value[key]
        if (candidate !== undefined && (!Number.isInteger(candidate) || Number(candidate) <= 0)) {
            issues.push(`edgeBrowsing.${key} must be a positive integer`)
        }
    }
    if (value.intervalSec !== undefined && (!Number.isInteger(value.intervalSec) || Number(value.intervalSec) < 305)) {
        issues.push('edgeBrowsing.intervalSec must be an integer greater than or equal to 305')
    }
    if (value.startJitterSec !== undefined) {
        if (!value.startJitterSec || typeof value.startJitterSec !== 'object' || Array.isArray(value.startJitterSec)) {
            issues.push('edgeBrowsing.startJitterSec must be an object')
        } else {
            const jitter = value.startJitterSec as Record<string, unknown>
            const min = Number(jitter.min)
            const max = Number(jitter.max)
            if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
                issues.push('edgeBrowsing.startJitterSec must contain non-negative min/max with max >= min')
            }
        }
    }
    return issues
}

export function emptyEdgeBrowsingSummary(): EdgeBrowsingSummary {
    return { completed: 0, waiting: 0, capped: 0, inactive: 0, absent: 0, failed: 0 }
}

export function combineEdgeBrowsingSummaries(summaries: EdgeBrowsingSummary[]): EdgeBrowsingSummary {
    return summaries.reduce<EdgeBrowsingSummary>((combined, summary) => ({
        completed: combined.completed + summary.completed,
        waiting: combined.waiting + summary.waiting,
        capped: combined.capped + summary.capped,
        inactive: combined.inactive + summary.inactive,
        absent: combined.absent + summary.absent,
        failed: combined.failed + summary.failed
    }), emptyEdgeBrowsingSummary())
}

export class EdgeBrowsingPool {
    private config: ConfigEdgeBrowsing
    private store: EdgeBrowsingStateStore
    private queue: QueueEntry[] = []
    private active = new Map<string, Promise<void>>()
    private enrolled = new Set<string>()
    private statuses = new Map<string, EdgeBrowsingRunStatus>()
    private now: () => Date
    private wait: (milliseconds: number) => Promise<void>
    private random: () => number
    private stopping = false

    constructor(private options: EdgeBrowsingPoolOptions) {
        this.config = resolveEdgeBrowsingConfig(options.config)
        this.now = options.now ?? (() => new Date())
        this.wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
        this.random = options.random ?? Math.random
        this.store = options.stateStore ?? new EdgeBrowsingStateStore(options.sessionPath, this.now)
    }

    async recordClassification(email: string, dom: EdgeDomClassification): Promise<void> {
        const status = this.classificationStatus(dom)
        this.statuses.set(email, status)
        await this.store.update(email, state => ({
            ...state,
            eligible: dom.status === 'in_progress' || dom.status === 'complete',
            progress: dom.progress ?? null,
            max: dom.max ?? null,
            plannedAttempts: dom.status === 'in_progress'
                ? this.plannedAttempts(dom.progress ?? 0, dom.max ?? this.config.targetMinutes, state.attemptsToday)
                : 0,
            nextDueAt: dom.status === 'in_progress' ? state.nextDueAt : null,
            runStatus: status,
            domClass: dom.status,
            lastError: dom.status === 'unknown' ? dom.reason ?? 'Edge DOM classification unknown' : undefined
        }))
    }

    async enroll(enrollment: EdgeBrowsingEnrollment): Promise<void> {
        if (enrollment.dom.status !== 'in_progress') return
        const emailKey = enrollment.email.toLowerCase()
        if (this.enrolled.has(emailKey)) return
        this.enrolled.add(emailKey)

        const domProgress = enrollment.dom.progress ?? 0
        const domMax = enrollment.dom.max ?? this.config.targetMinutes
        await this.store.update(enrollment.email, state => ({
            ...state,
            eligible: true,
            progress: domProgress,
            max: domMax,
            plannedAttempts: this.plannedAttempts(domProgress, domMax, state.attemptsToday),
            runStatus: 'enrolled',
            domClass: enrollment.dom.status
        }))
        this.statuses.set(enrollment.email, 'enrolled')
        this.queue.push({ ...enrollment, domProgress, domMax })
        this.pump()
    }

    async drain(): Promise<EdgeBrowsingSummary> {
        this.pump()
        const deadline = this.now().getTime() + this.config.drainTimeoutMin * 60_000

        while ((this.queue.length > 0 || this.active.size > 0) && this.now().getTime() < deadline) {
            await this.wait(Math.min(500, Math.max(1, deadline - this.now().getTime())))
        }

        if (this.queue.length > 0 || this.active.size > 0) {
            this.stopping = true
            const queued = this.queue.splice(0)
            await Promise.all(queued.map(entry => this.markWaiting(entry.email, 'Edge pool drain timeout')))
            await Promise.allSettled(Array.from(this.active.values()))
        }

        return this.summary()
    }

    summary(): EdgeBrowsingSummary {
        const summary = emptyEdgeBrowsingSummary()
        for (const status of this.statuses.values()) {
            if (status === 'completed') summary.completed++
            else if (status === 'waiting' || status === 'enrolled' || status === 'reporting') summary.waiting++
            else if (status === 'capped') summary.capped++
            else if (status === 'inactive') summary.inactive++
            else if (status === 'absent') summary.absent++
            else if (status === 'failed') summary.failed++
        }
        return summary
    }

    private pump(): void {
        if (this.stopping) return
        while (this.active.size < this.config.finalConcurrency && this.queue.length > 0) {
            const entry = this.queue.shift()!
            const task = this.runEntry(entry)
                .catch(error => this.fail(entry.email, error))
                .finally(() => {
                    this.active.delete(entry.email)
                    this.pump()
                })
            this.active.set(entry.email, task)
        }
    }

    private async runEntry(entry: QueueEntry): Promise<void> {
        const jitterMs = this.randomBetween(
            this.config.startJitterSec.min * 1000,
            this.config.startJitterSec.max * 1000
        )
        if (jitterMs > 0 && !(await this.interruptibleWait(jitterMs))) {
            await this.markWaiting(entry.email, 'Edge pool stopped before first report')
            return
        }

        const client = this.options.clientFactory
            ? this.options.clientFactory(entry)
            : new EdgeBrowsingClient(
                entry.token.access_token,
                this.options.requestFactory(entry.email),
                'CN',
                this.normalizeLanguage(entry.dom.language)
            )
        let apiBaseline: number | null = null

        while (!this.stopping) {
            let state = await this.store.read(entry.email)
            if (state.attemptsToday >= this.config.maxAttemptsPerDay) {
                await this.setStatus(entry.email, 'capped', { nextDueAt: null })
                return
            }

            const dueAt = state.nextDueAt ? Date.parse(state.nextDueAt) : this.now().getTime()
            if (Number.isFinite(dueAt) && dueAt > this.now().getTime()) {
                if (!(await this.interruptibleWait(dueAt - this.now().getTime()))) {
                    await this.markWaiting(entry.email, 'Edge pool drain timeout')
                    return
                }
            }

            await this.setStatus(entry.email, 'reporting')
            const before = await client.getStatus()
            if (!before.found) throw new Error('Edge offer missing from dapi status')
            if (this.isComplete(before)) {
                await this.complete(entry.email, entry.domMax)
                return
            }
            if (apiBaseline === null && before.progress !== null) apiBaseline = before.progress

            const report = await client.reportActivity()
            state = await this.store.update(entry.email, current => ({
                ...current,
                attemptsToday: current.attemptsToday + 1,
                plannedAttempts: Math.max(0, this.config.maxAttemptsPerDay - current.attemptsToday - 1),
                lastPoints: report.points,
                runStatus: 'reporting'
            }))

            const after = await client.getStatus()
            if (!after.found) throw new Error('Edge offer missing after activity report')
            const verifiedProgress = this.verifiedProgress(entry, apiBaseline, after)
            if (this.isComplete(after) || verifiedProgress >= entry.domMax) {
                await this.complete(entry.email, verifiedProgress)
                return
            }

            if (state.attemptsToday >= this.config.maxAttemptsPerDay) {
                await this.setStatus(entry.email, 'capped', {
                    progress: verifiedProgress,
                    nextDueAt: null,
                    reportPerMinutes: after.reportPerMinutes
                })
                return
            }

            const nextDueAt = new Date(this.now().getTime() + this.config.intervalSec * 1000).toISOString()
            await this.setStatus(entry.email, 'waiting', {
                progress: verifiedProgress,
                nextDueAt,
                reportPerMinutes: after.reportPerMinutes
            })
        }

        await this.markWaiting(entry.email, 'Edge pool drain timeout')
    }

    private verifiedProgress(entry: QueueEntry, baseline: number | null, status: EdgeBrowsingStatus): number {
        if (baseline === null || status.progress === null) return entry.domProgress
        const delta = Math.max(0, status.progress - baseline)
        return Math.min(entry.domMax, entry.domProgress + delta)
    }

    private isComplete(status: EdgeBrowsingStatus): boolean {
        return status.complete || (
            status.progress !== null &&
            status.max !== null &&
            status.max > 0 &&
            status.progress >= status.max
        )
    }

    private async complete(email: string, progress: number): Promise<void> {
        await this.setStatus(email, 'completed', {
            progress,
            nextDueAt: null,
            plannedAttempts: 0,
            lastError: undefined
        })
        this.options.log(`${email}: Edge browsing completed`)
    }

    private async fail(email: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error)
        await this.setStatus(email, 'failed', { nextDueAt: null, lastError: message.slice(0, 240) })
        this.options.log(`${email}: Edge browsing failed: ${message}`, 'warn')
    }

    private async markWaiting(email: string, reason: string): Promise<void> {
        await this.setStatus(email, 'waiting', { lastError: reason })
    }

    private async setStatus(email: string, status: EdgeBrowsingRunStatus, patch: Partial<EdgeBrowsingState> = {}): Promise<void> {
        this.statuses.set(email, status)
        await this.store.update(email, state => ({ ...state, ...patch, runStatus: status }))
    }

    private classificationStatus(dom: EdgeDomClassification): EdgeBrowsingRunStatus {
        if (dom.status === 'complete') return 'completed'
        if (dom.status === 'inactive') return 'inactive'
        if (dom.status === 'in_progress') return 'waiting'
        if (dom.status === 'absent') return 'absent'
        return 'failed'
    }

    private normalizeLanguage(language: string): string {
        if (/^zh/i.test(language)) return 'zh-CN'
        return language || 'en'
    }

    private randomBetween(min: number, max: number): number {
        if (max <= min) return Math.round(min)
        return Math.round(min + this.random() * (max - min))
    }

    private plannedAttempts(progress: number, max: number, attemptsToday: number): number {
        const remainingReports = Math.ceil(Math.max(0, max - progress) / 5)
        return Math.min(remainingReports, Math.max(0, this.config.maxAttemptsPerDay - attemptsToday))
    }

    private async interruptibleWait(milliseconds: number): Promise<boolean> {
        let remaining = Math.max(0, milliseconds)
        while (remaining > 0 && !this.stopping) {
            const slice = Math.min(1000, remaining)
            await this.wait(slice)
            remaining -= slice
        }
        return !this.stopping
    }
}
