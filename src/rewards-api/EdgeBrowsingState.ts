import { promises as fs } from 'fs'
import path from 'path'

export type EdgeBrowsingRunStatus =
    | 'absent'
    | 'inactive'
    | 'enrolled'
    | 'waiting'
    | 'reporting'
    | 'completed'
    | 'capped'
    | 'failed'

export interface EdgeBrowsingState {
    date: string
    eligible: boolean
    progress: number | null
    max: number | null
    plannedAttempts: number
    attemptsToday: number
    nextDueAt: string | null
    runStatus: EdgeBrowsingRunStatus
    updatedAt: string
    reportPerMinutes?: number
    lastPoints?: number
    lastError?: string
    domClass?: string
}

export type EdgeBrowsingStateUpdater = (state: EdgeBrowsingState) => EdgeBrowsingState | Promise<EdgeBrowsingState>

export function edgeBrowsingDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function createEdgeBrowsingState(now = new Date()): EdgeBrowsingState {
    return {
        date: edgeBrowsingDateKey(now),
        eligible: false,
        progress: null,
        max: null,
        plannedAttempts: 0,
        attemptsToday: 0,
        nextDueAt: null,
        runStatus: 'absent',
        updatedAt: now.toISOString()
    }
}

export class EdgeBrowsingStateStore {
    private locks = new Map<string, Promise<void>>()

    constructor(private sessionPath: string, private now: () => Date = () => new Date()) {}

    async read(email: string): Promise<EdgeBrowsingState> {
        return this.withLock(email, () => this.readUnlocked(email))
    }

    async update(email: string, updater: EdgeBrowsingStateUpdater): Promise<EdgeBrowsingState> {
        return this.withLock(email, async () => {
            const current = await this.readUnlocked(email)
            const updated = await updater({ ...current })
            updated.date = edgeBrowsingDateKey(this.now())
            updated.updatedAt = this.now().toISOString()
            await this.writeUnlocked(email, updated)
            return updated
        })
    }

    private async readUnlocked(email: string): Promise<EdgeBrowsingState> {
        const now = this.now()
        const fresh = createEdgeBrowsingState(now)
        try {
            const raw = await fs.readFile(this.filePath(email), 'utf8')
            const parsed = JSON.parse(raw) as Partial<EdgeBrowsingState>
            if (parsed.date !== fresh.date) return fresh

            return {
                ...fresh,
                ...parsed,
                date: fresh.date,
                eligible: parsed.eligible === true,
                attemptsToday: this.nonNegativeInteger(parsed.attemptsToday),
                plannedAttempts: this.nonNegativeInteger(parsed.plannedAttempts),
                progress: this.nullableNonNegativeNumber(parsed.progress),
                max: this.nullableNonNegativeNumber(parsed.max),
                nextDueAt: typeof parsed.nextDueAt === 'string' ? parsed.nextDueAt : null,
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fresh.updatedAt
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
            return fresh
        }
    }

    private async writeUnlocked(email: string, state: EdgeBrowsingState): Promise<void> {
        const filePath = this.filePath(email)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        await fs.rename(temporaryPath, filePath)
    }

    private filePath(email: string): string {
        return path.join(this.sessionPath, email, 'edge_browsing_state.json')
    }

    private nonNegativeInteger(value: unknown): number {
        const parsed = Number(value)
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
    }

    private nullableNonNegativeNumber(value: unknown): number | null {
        if (value === null || value === undefined) return null
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    }

    private async withLock<T>(email: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(email) ?? Promise.resolve()
        let release!: () => void
        const current = new Promise<void>(resolve => { release = resolve })
        const tail = previous.then(() => current)
        this.locks.set(email, tail)
        await previous

        try {
            return await operation()
        } finally {
            release()
            if (this.locks.get(email) === tail) this.locks.delete(email)
        }
    }
}
