export interface Config {
    baseURL: string;
    sessionPath: string;
    headless: boolean;
    forceRelogin?: boolean;
    parallel: boolean;
    runOnZeroPoints: boolean;
    clusters: number;
    saveFingerprint: ConfigSaveFingerprint;
    workers: ConfigWorkers;
    searchOnBingLocalQueries: boolean;
    globalTimeout: string;
    accountDelay?: {
        min: string;
        max: string;
    };
    searchSettings: ConfigSearchSettings;
    logExcludeFunc: string[];
    webhookLogExcludeFunc: string[];
    proxy: ConfigProxy;
    webhook: ConfigWebhook;
    popupHandling?: ConfigPopupHandling;
    passkeyHandling?: ConfigPasskeyHandling;
    visualSearch?: Partial<ConfigVisualSearch>;
}

export interface ConfigSaveFingerprint {
    mobile: boolean;
    desktop: boolean;
}

export interface ConfigSearchSettings {
    useGeoLocaleQueries: boolean;
    scrollRandomResults: boolean;
    clickRandomResults: boolean;
    searchDelay?: ConfigSearchDelay | ConfigLegacySearchDelay;
    retryMobileSearchAmount: number;
    multiLanguage?: ConfigMultiLanguage;
    autoTimezone?: ConfigAutoTimezone;
    chinaRegionAdaptation?: ConfigChinaRegion;
}

export interface ConfigMultiLanguage {
    enabled: boolean;
    autoDetectLocation: boolean;
    fallbackLanguage: string;
    supportedLanguages: string[];
}

export interface ConfigAutoTimezone {
    enabled: boolean;
    setOnStartup: boolean;
    validateMatch: boolean;
    logChanges: boolean;
}

export type ConfigDuration = number | string;

export interface ConfigSearchDelayRange {
    min: ConfigDuration;
    max: ConfigDuration;
}

export interface ConfigSearchDelay {
    desktop: ConfigSearchDelayRange;
    mobile: ConfigSearchDelayRange;
    longPauseProbability: number;
    longPause: ConfigSearchDelayRange;
    hardMax: ConfigDuration;
}

/** Legacy flat shape. Accepted only for deprecation detection and migration warnings. */
export interface ConfigLegacySearchDelay {
    min: number | string;
    max: number | string;
}

export interface ConfigWebhook {
    enabled: boolean;
    url: string;
}

export interface ConfigProxy {
    proxyGoogleTrends: boolean;
    proxyBingTerms: boolean;
}

export interface ConfigWorkers {
    doDailySet: boolean;
    doMorePromotions: boolean;
    doPunchCards: boolean;
    doDesktopSearch: boolean;
    doMobileSearch: boolean;
    doDailyCheckIn: boolean;
    doReadToEarn: boolean;
    doVisualSearch?: boolean;
}

export interface ConfigVisualSearch {
    imageDirectory: string;
    taskTimeout: ConfigDuration;
    completionTimeout: ConfigDuration;
    maxUploadAttempts: number;
}

export interface ConfigChinaRegion {
    enabled: boolean;
    useBaiduTrends: boolean;
    useWeiboTrends: boolean;
    fallbackToLocalQueries: boolean;
}

export interface ConfigPopupHandling {
    enabled: boolean;
    handleReferralPopups?: boolean;
    handleStreakProtectionPopups?: boolean;
    handleStreakRestorePopups?: boolean;
    handleGenericModals?: boolean;
    logPopupHandling?: boolean;
}

export interface ConfigPasskeyHandling {
    enabled: boolean;
    maxAttempts?: number;
    skipPasskeySetup?: boolean;
    useDirectNavigation?: boolean;
    logPasskeyHandling?: boolean;
}
