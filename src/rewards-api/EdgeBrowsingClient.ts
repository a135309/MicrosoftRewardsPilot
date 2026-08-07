import type { AxiosRequestConfig, AxiosResponse } from 'axios'

const DAPI_BASE = 'https://prod.rewardsplatform.microsoft.com/dapi'
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'

export interface EdgeBrowsingStatus {
    found: boolean
    complete: boolean
    progress: number | null
    max: number | null
    reportPerMinutes: number
}

export interface EdgeBrowsingReportResult {
    points: number
    balance: number
    duplicate: boolean
}

export type EdgeBrowsingRequest = (config: AxiosRequestConfig) => Promise<AxiosResponse>

export interface EdgeBrowsingClientLike {
    getStatus(): Promise<EdgeBrowsingStatus>
    reportActivity(): Promise<EdgeBrowsingReportResult>
}

export class EdgeBrowsingClient implements EdgeBrowsingClientLike {
    constructor(
        private accessToken: string,
        private request: EdgeBrowsingRequest,
        private country = 'CN',
        private language = 'zh-CN'
    ) {}

    async getStatus(): Promise<EdgeBrowsingStatus> {
        const response = await this.request({
            url: `${DAPI_BASE}/me?channel=edge`,
            method: 'GET',
            timeout: 30_000,
            headers: this.headers()
        })
        const promotions = response.data?.response?.promotions
        if (!Array.isArray(promotions)) return this.missingStatus()

        for (const promotion of promotions) {
            const attributes = promotion?.attributes ?? {}
            const offerId = String(attributes.offerid ?? '')
            const name = String(promotion?.name ?? '')
            if (offerId !== 'DailyCheckIn_Edge' && name !== 'edge_browsing_streak_flight') continue

            return {
                found: true,
                complete: this.booleanValue(attributes.complete),
                progress: this.numberValue(attributes.progress),
                max: this.numberValue(attributes.max),
                reportPerMinutes: Math.max(1, this.numberValue(attributes.report_per_minutes) ?? 5)
            }
        }

        return this.missingStatus()
    }

    async reportActivity(): Promise<EdgeBrowsingReportResult> {
        const response = await this.request({
            url: `${DAPI_BASE}/me/activities`,
            method: 'POST',
            timeout: 30_000,
            headers: this.headers(true),
            data: {
                amount: 1,
                attributes: { offerid: 'DailyCheckIn_Edge' },
                request_user_info: true,
                type: '29'
            }
        })
        const result = response.data?.response ?? {}
        return {
            points: this.numberValue(result.activity?.p) ?? 0,
            balance: this.numberValue(result.balance) ?? 0,
            duplicate: Boolean(result.isDuplicate)
        }
    }

    private headers(json = false): Record<string, string> {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.accessToken}`,
            'X-Rewards-PartnerId': 'EdgeHub',
            'X-Rewards-AppId': 'EdgeDesktop',
            'X-Rewards-Country': this.country.toUpperCase(),
            'X-Rewards-Language': this.language,
            'User-Agent': EDGE_USER_AGENT,
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate, zstd'
        }
        if (json) headers['Content-Type'] = 'application/json'
        return headers
    }

    private missingStatus(): EdgeBrowsingStatus {
        return { found: false, complete: false, progress: null, max: null, reportPerMinutes: 5 }
    }

    private numberValue(value: unknown): number | null {
        if (value === null || value === undefined || value === '') return null
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }

    private booleanValue(value: unknown): boolean {
        if (typeof value === 'boolean') return value
        return ['true', '1', 'yes'].includes(String(value ?? '').toLowerCase())
    }
}
