import { GeoLanguageDetector } from './GeoLanguage'
import { log } from './Logger'
import { loadConfig } from './Load'
import { normalizeSearchDelayConfig } from '../src/anti-detection/intelligent-delay'
import { validateVisualSearchConfig } from '../src/visual-search/types'
import { validateEdgeBrowsingConfig } from '../src/rewards-api/EdgeBrowsingPool'

// 定义自动时区配置接口
interface AutoTimezoneConfig {
    enabled: boolean
    validateMatch: boolean
    setOnStartup: boolean
    logChanges: boolean
}

// 定义启动摘要接口
interface StartupSummaryTimezone {
    current: string
    offset: string
    name: string
    isDST: boolean
    matchesLocation: boolean
    detectedTimezone: string
}

interface StartupSummaryGeolocation {
    country: string
    countryCode: string
    city: string
    language: string
    languageName: string
    ip: string
}

interface StartupSummary {
    timezone: StartupSummaryTimezone
    geolocation: StartupSummaryGeolocation
    recommendations: string[]
}

export class StartupConfig {
    /**
     * 程序启动时的自动配置初始化
     */
    static async initialize(): Promise<void> {
        try {
            log(false, 'STARTUP-CONFIG', 'Initializing startup configurations...')
            
            // 加载配置文件
            const config = loadConfig()

            const validation = this.validateConfiguration()
            for (const issue of validation.issues) {
                log(false, 'STARTUP-CONFIG', issue, 'warn')
            }
            if (!validation.isValid) {
                throw new Error(`Invalid configuration: ${validation.issues.join('; ')}`)
            }

            // 1. 自动时区设置
            if (config.searchSettings?.autoTimezone?.enabled) {
                await this.initializeTimezone(config.searchSettings.autoTimezone)
            }
            
            // 2. 地理位置和语言检测
            if (config.searchSettings?.multiLanguage?.autoDetectLocation) {
                await this.initializeGeoLanguage()
            }
            
            log(false, 'STARTUP-CONFIG', 'Startup configuration initialization completed')
            
        } catch (error) {
            log(false, 'STARTUP-CONFIG', `Error during startup configuration: ${error}`, 'warn')
            throw error
        }
    }

    /**
     * 初始化时区设置
     */
    private static async initializeTimezone(autoTimezoneConfig: AutoTimezoneConfig): Promise<void> {
        try {
            log(false, 'STARTUP-TIMEZONE', 'Initializing timezone configuration...')
            
            // 检查时区匹配状态
            if (autoTimezoneConfig.validateMatch) {
                const timezoneMatch = await GeoLanguageDetector.checkTimezoneLocationMatch()
                
                if (autoTimezoneConfig.logChanges) {
                    log(false, 'STARTUP-TIMEZONE', 
                        `Timezone match check: ${timezoneMatch.isMatched ? 'MATCHED' : 'MISMATCH'} | ` +
                        `Current: ${timezoneMatch.currentTimezone} | ` +
                        `Detected: ${timezoneMatch.detectedTimezone}`)
                }
                
                // 如果启用启动时设置且时区不匹配
                if (autoTimezoneConfig.setOnStartup && !timezoneMatch.isMatched) {
                    log(false, 'STARTUP-TIMEZONE', 'Attempting automatic timezone adjustment...')
                    
                    const success = await GeoLanguageDetector.autoSetTimezone()
                    if (success) {
                        log(false, 'STARTUP-TIMEZONE', 
                            `✅ Timezone automatically adjusted to match location: ${timezoneMatch.detectedTimezone}`)
                    } else {
                        log(false, 'STARTUP-TIMEZONE', 
                            '❌ Failed to adjust timezone automatically, keeping current setting', 'warn')
                    }
                } else if (timezoneMatch.isMatched) {
                    log(false, 'STARTUP-TIMEZONE', 
                        `✅ Timezone already matches geographical location: ${timezoneMatch.currentTimezone}`)
                }
            }
            
            // 显示最终时区信息
            const timezoneInfo = GeoLanguageDetector.getTimezoneInfo()
            log(false, 'STARTUP-TIMEZONE', 
                `Final timezone: ${timezoneInfo.current} (${timezoneInfo.offset}) - ${timezoneInfo.name}`)
            
        } catch (error) {
            log(false, 'STARTUP-TIMEZONE', `Error initializing timezone: ${error}`, 'warn')
        }
    }

    /**
     * 初始化地理位置和语言设置
     */
    private static async initializeGeoLanguage(): Promise<void> {
        try {
            log(false, 'STARTUP-GEO', 'Initializing geographical location and language detection...')
            
            // 获取地理位置信息
            const location = await GeoLanguageDetector.getCurrentLocation()
            
            // 记录检测结果
            log(false, 'STARTUP-GEO', 
                `Location detected: ${location.country} (${location.countryCode}) | ` +
                `City: ${location.city} | Language: ${location.language} | ` +
                `Timezone: ${location.timezone}`)
            
            // 获取语言配置
            const languageConfig = GeoLanguageDetector.getLanguageConfig(location.language)
            log(false, 'STARTUP-GEO', 
                `Language configuration loaded: ${languageConfig.name} (${languageConfig.code}) | ` +
                `Google Trends Region: ${languageConfig.googleTrendsLocale}`)
            
            // 缓存预热：生成一些示例查询用于验证
            const sampleQueries = [
                ...languageConfig.searchQueries.news.slice(0, 2),
                ...languageConfig.searchQueries.common.slice(0, 2)
            ]
            
            log(false, 'STARTUP-GEO', 
                `Sample localized queries: ${sampleQueries.join(', ')}`)
            
        } catch (error) {
            log(false, 'STARTUP-GEO', `Error initializing geo-language detection: ${error}`, 'warn')
        }
    }

    /**
     * 获取启动配置摘要
     */
    static async getStartupSummary(): Promise<StartupSummary> {
        const recommendations: string[] = []
        
        try {
            // 时区信息
            const timezoneInfo = GeoLanguageDetector.getTimezoneInfo()
            const timezoneMatch = await GeoLanguageDetector.checkTimezoneLocationMatch()
            
            if (!timezoneMatch.isMatched) {
                recommendations.push(`时区建议: ${timezoneMatch.recommendation}`)
            }
            
            // 地理位置信息
            const location = await GeoLanguageDetector.getCurrentLocation()
            const languageConfig = GeoLanguageDetector.getLanguageConfig(location.language)
            
            return {
                timezone: {
                    current: timezoneInfo.current,
                    offset: timezoneInfo.offset,
                    name: timezoneInfo.name,
                    isDST: timezoneInfo.isDST,
                    matchesLocation: timezoneMatch.isMatched,
                    detectedTimezone: timezoneMatch.detectedTimezone
                },
                geolocation: {
                    country: location.country,
                    countryCode: location.countryCode,
                    city: location.city,
                    language: location.language,
                    languageName: languageConfig.name,
                    ip: location.ip
                },
                recommendations
            }
        } catch (error) {
            return {
                timezone: {
                    current: 'Unknown',
                    offset: 'Unknown',
                    name: 'Failed to detect timezone',
                    isDST: false,
                    matchesLocation: false,
                    detectedTimezone: 'Unknown'
                },
                geolocation: {
                    country: 'Unknown',
                    countryCode: 'Unknown',
                    city: 'Unknown',
                    language: 'en',
                    languageName: 'Failed to detect location',
                    ip: 'Unknown'
                },
                recommendations: ['无法检测地理位置，请检查网络连接']
            }
        }
    }

    /**
     * 验证配置的完整性
     */
    static validateConfiguration(): {
        isValid: boolean
        issues: string[]
        suggestions: string[]
    } {
        const issues: string[] = []
        const suggestions: string[] = []
        
        try {
            const config = loadConfig()
            
            // 检查多语言配置
            if (!config.searchSettings?.multiLanguage?.enabled) {
                suggestions.push('建议启用 searchSettings.multiLanguage.enabled 以获得更好的反检测效果')
            }
            
            // 检查自动时区配置
            if (!config.searchSettings?.autoTimezone?.enabled) {
                suggestions.push('建议启用 searchSettings.autoTimezone.enabled 以自动匹配地理位置时区')
            }
            
            // 检查全局超时设置
            if (!config.globalTimeout) {
                issues.push('缺少 globalTimeout 配置')
            }
            
            // 检查搜索延迟设置
            if (!config.searchSettings?.searchDelay) {
                suggestions.push('建议配置 searchSettings.searchDelay 以优化搜索速度')
            } else {
                try {
                    normalizeSearchDelayConfig(config.searchSettings.searchDelay)
                } catch (error) {
                    issues.push(`searchSettings.searchDelay 配置无效: ${error instanceof Error ? error.message : String(error)}`)
                }
            }

            if (config.workers.doVisualSearch !== undefined && typeof config.workers.doVisualSearch !== 'boolean') {
                issues.push('workers.doVisualSearch must be a boolean')
            }
            if (config.workers.doEdgeBrowsing !== undefined && typeof config.workers.doEdgeBrowsing !== 'boolean') {
                issues.push('workers.doEdgeBrowsing must be a boolean')
            }
            issues.push(...validateVisualSearchConfig(config.visualSearch))
            issues.push(...validateEdgeBrowsingConfig(config.edgeBrowsing))
            
            const isValid = issues.length === 0
            
            return { isValid, issues, suggestions }
            
        } catch (error) {
            return {
                isValid: false,
                issues: [`配置文件加载失败: ${error}`],
                suggestions: ['请检查 config.json 文件格式是否正确']
            }
        }
    }
}
