import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { load } from 'cheerio'

import { getBrowserLaunchArgs, validateBrowserNetwork } from '../browser/Browser'
import { DashboardDetector, classifyDashboardCard, parseProgress, validateVisualSearchTaskUrl } from '../src/visual-search/DashboardDetector'
import { ImageRepository } from '../src/visual-search/ImageRepository'
import { resolveVisualSearchManualPause, VisualSearchRunner, isVisualResultUrl } from '../src/visual-search/VisualSearchRunner'
import {
    DEFAULT_VISUAL_SEARCH_CONFIG,
    isVisualSearchComplete,
    resolveVisualSearchConfig,
    resolveVisualSearchProxy,
    validateVisualSearchConfig
} from '../src/visual-search/types'
import { createDirectAxiosInstance } from '../utils/Axios'
import { filterAccounts } from '../utils/Load'

let passed = 0

function test(name: string, action: () => void): void {
    action()
    passed++
    console.log(`PASS ${name}`)
}

async function asyncTest(name: string, action: () => Promise<void>): Promise<void> {
    await action()
    passed++
    console.log(`PASS ${name}`)
}

async function main(): Promise<void> {
    test('progress parser accepts numeric ARIA values', () => {
        assert.deepStrictEqual(parseProgress('0', '1'), { current: 0, max: 1 })
        assert.strictEqual(parseProgress('', '1'), null)
        assert.strictEqual(parseProgress('0', '0'), null)
    })

    test('dashboard screening distinguishes all four states', () => {
        assert.strictEqual(classifyDashboardCard(false, true, null), 'absent')
        assert.strictEqual(classifyDashboardCard(true, true, { current: 1, max: 1 }), 'already_complete')
        assert.strictEqual(classifyDashboardCard(true, true, { current: 0, max: 1 }), 'candidate')
        assert.strictEqual(classifyDashboardCard(false, false, null), 'uncertain')
        assert.strictEqual(classifyDashboardCard(true, true, null), 'uncertain')
    })

    test('task URL requires HTTPS Bing host and both features', () => {
        assert.ok(validateVisualSearchTaskUrl('https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES'))
        assert.ok(validateVisualSearchTaskUrl('https://cn.bing.com/?features=vstooltip,vsstreak'))
        assert.strictEqual(validateVisualSearchTaskUrl('http://www.bing.com/?features=vsstreak,vstooltip'), null)
        assert.strictEqual(validateVisualSearchTaskUrl('https://bing.com.example/?features=vsstreak,vstooltip'), null)
        assert.strictEqual(validateVisualSearchTaskUrl('https://www.bing.com/?features=vsstreak'), null)
    })

    test('English and Chinese fixtures use stable icon and ARIA selectors', () => {
        for (const language of ['en-US', 'zh-CN']) {
            const $ = load(`<html lang="${language}"><body>
                <button hidden><img src="/assets/search_visual.svg"><div role="progressbar" aria-valuenow="0" aria-valuemax="1"></div></button>
                <button><img src="/assets/search_visual.svg"><div role="progressbar" aria-valuenow="0" aria-valuemax="1"></div></button>
            </body></html>`)
            const cards = $('button:has(img[src*="search_visual.svg"])').filter((_, element) => !$(element).is('[hidden]'))
            assert.strictEqual(cards.length, 1)
            const progress = cards.find('[role="progressbar"]')
            assert.deepStrictEqual(parseProgress(progress.attr('aria-valuenow') ?? null, progress.attr('aria-valuemax') ?? null), { current: 0, max: 1 })
        }
    })

    test('English and Chinese Visual popup fixtures use language-neutral selectors', () => {
        for (const fixture of [
            { lang: 'en-US', camera: 'Search using an image', upload: 'upload an image' },
            { lang: 'zh-CN', camera: '使用图像搜索', upload: '上传图像' }
        ]) {
            const $ = load(`<html lang="${fixture.lang}"><body>
                <div id="sb_cam_island" role="button" aria-label="${fixture.camera}"></div>
                <div id="sb_sbidialog" shdlg>
                    <span id="sb_brtext" role="button" aria-label="${fixture.upload}"></span>
                    <input id="sb_fileinput" type="file">
                </div>
            </body></html>`)
            assert.strictEqual($('#sb_cam_island[role="button"]').length, 1)
            assert.strictEqual($('#sb_sbidialog[shdlg] #sb_brtext').length, 1)
            assert.strictEqual($('#sb_sbidialog[shdlg] #sb_fileinput[type="file"]').length, 1)
        }
    })

    test('result URL requires search path, FORM and non-empty bcid', () => {
        assert.strictEqual(isVisualResultUrl('https://www.bing.com/images/search?bcid=abc&FORM=SBIHMP'), true)
        assert.strictEqual(isVisualResultUrl('https://www.bing.com/images/search?FORM=SBIHMP'), false)
        assert.strictEqual(isVisualResultUrl('https://www.bing.com/?bcid=abc&FORM=SBIHMP'), false)
    })

    test('completion requires both sources to advance and reach max', () => {
        const before = { current: 0, max: 1 }
        assert.strictEqual(isVisualSearchComplete(before, before, { current: 1, max: 1 }, { current: 1, max: 1 }), true)
        assert.strictEqual(isVisualSearchComplete(before, before, { current: 1, max: 1 }, { current: 0, max: 1 }), false)
        assert.strictEqual(isVisualSearchComplete({ current: 1, max: 1 }, before, { current: 1, max: 1 }, { current: 1, max: 1 }), false)
    })

    test('missing config receives backward-compatible defaults', () => {
        assert.deepStrictEqual(resolveVisualSearchConfig(), DEFAULT_VISUAL_SEARCH_CONFIG)
        assert.deepStrictEqual(resolveVisualSearchConfig({ completionTimeout: '2min' }), {
            ...DEFAULT_VISUAL_SEARCH_CONFIG,
            completionTimeout: '2min'
        })
    })

    test('config validator rejects unsafe upload count and bad directory', () => {
        assert.deepStrictEqual(validateVisualSearchConfig(undefined), [])
        assert.strictEqual(validateVisualSearchConfig({ maxUploadAttempts: 2 }).length, 1)
        assert.strictEqual(validateVisualSearchConfig({ imageDirectory: '' }).length, 1)
        assert.strictEqual(validateVisualSearchConfig({ taskTimeout: 'soon' }).length, 1)
        assert.strictEqual(validateVisualSearchConfig({ proxy: {} }).length, 1)
        assert.strictEqual(validateVisualSearchConfig({ proxy: { server: 'ftp://127.0.0.1:21' } }).length, 1)
    })

    test('Visual Search proxy uses environment override and never falls back to account proxy', () => {
        const settings = resolveVisualSearchConfig({
            proxy: {
                server: 'http://127.0.0.1:7897',
                username: 'config-user',
                password: 'config-pass'
            }
        })
        assert.deepStrictEqual(resolveVisualSearchProxy(settings, {}), {
            proxyAxios: true,
            url: 'http://127.0.0.1',
            port: 7897,
            username: 'config-user',
            password: 'config-pass'
        })
        assert.deepStrictEqual(resolveVisualSearchProxy(settings, {
            VISUAL_SEARCH_PROXY_SERVER: 'socks5://localhost:1080',
            VISUAL_SEARCH_PROXY_USERNAME: 'env-user',
            VISUAL_SEARCH_PROXY_PASSWORD: 'env-pass'
        }), {
            proxyAxios: true,
            url: 'socks5://localhost',
            port: 1080,
            username: 'env-user',
            password: 'env-pass'
        })
        assert.deepStrictEqual(resolveVisualSearchProxy(settings, {
            VISUAL_SEARCH_PROXY_SERVER: 'http://localhost:8080'
        }), {
            proxyAxios: true,
            url: 'http://localhost',
            port: 8080,
            username: '',
            password: ''
        })
        assert.throws(() => resolveVisualSearchProxy(resolveVisualSearchConfig(), {}), /proxy is required/)
        assert.throws(
            () => resolveVisualSearchProxy(settings, { VISUAL_SEARCH_PROXY_SERVER: 'not-a-url' }),
            /proxy server is invalid/
        )
    })

    test('browser direct mode bypasses system proxy while proxy mode stays explicit', () => {
        const directArgs = getBrowserLaunchArgs({ mode: 'direct' }, { BROWSER_CDP_PORT: '9222' })
        assert.ok(directArgs.includes('--no-proxy-server'))
        assert.ok(directArgs.includes('--remote-debugging-port=9222'))

        const proxy = {
            proxyAxios: true,
            url: 'http://127.0.0.1',
            port: 7897,
            username: '',
            password: ''
        }
        validateBrowserNetwork({ mode: 'proxy', proxy })
        assert.strictEqual(getBrowserLaunchArgs({ mode: 'proxy', proxy }, {}).includes('--no-proxy-server'), false)
        assert.throws(() => getBrowserLaunchArgs({ mode: 'direct' }, { BROWSER_CDP_PORT: 'bad' }), /BROWSER_CDP_PORT/)
    })

    test('Axios direct instances ignore proxy environment settings', () => {
        assert.strictEqual(createDirectAxiosInstance().defaults.proxy, false)
    })

    test('account filter is case-insensitive and fails closed on zero matches', () => {
        const accounts = [
            { email: 'first@example.com' },
            { email: 'SECOND@example.com' }
        ] as never[]
        assert.deepStrictEqual(filterAccounts(accounts, ' second@EXAMPLE.com '), [accounts[1]])
        assert.deepStrictEqual(filterAccounts(accounts, ''), accounts)
        assert.throws(() => filterAccounts(accounts, 'missing@example.com'), /matched no accounts/)
    })

    test('manual Visual pause is opt-in and uses long-lived resume marker', () => {
        assert.strictEqual(resolveVisualSearchManualPause({}), undefined)
        assert.deepStrictEqual(resolveVisualSearchManualPause({
            VISUAL_SEARCH_MANUAL_PAUSE: '1',
            VISUAL_SEARCH_MANUAL_PAUSE_TIMEOUT_MS: '60000',
            VISUAL_SEARCH_MANUAL_RESUME_FILE: '.tmp-visual-resume'
        }, process.cwd()), {
            resumeFile: path.resolve(process.cwd(), '.tmp-visual-resume'),
            timeoutMs: 60000
        })
        assert.throws(() => resolveVisualSearchManualPause({
            VISUAL_SEARCH_MANUAL_PAUSE: '1',
            VISUAL_SEARCH_MANUAL_PAUSE_TIMEOUT_MS: '1000'
        }), /integer >= 30000/)
    })

    await asyncTest('image repository accepts magic-matched image only', async () => {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'visual-search-test-'))
        try {
            const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
            await fs.promises.writeFile(path.join(directory, 'valid.png'), pngHeader)
            await fs.promises.writeFile(path.join(directory, 'fake.jpg'), 'not-an-image')
            await fs.promises.writeFile(path.join(directory, 'ignored.txt'), pngHeader)

            const repository = await ImageRepository.open(directory)
            assert.strictEqual(repository.size, 1)
            assert.strictEqual(path.basename(repository.pick() ?? ''), 'valid.png')
        } finally {
            await fs.promises.rm(directory, { recursive: true, force: true })
        }
    })

    await asyncTest('dialog uses visible role fallback and does not double-click after opening', async () => {
        let triggerClicks = 0
        const trigger = { isVisible: async () => true, click: async () => { triggerClicks++ } }
        const page = {
            locator: (selector: string) => {
                if (selector === '#sb_cam_island[role="button"]') return { first: () => ({ isVisible: async () => false }) }
                if (selector === '#sb_sbip') return { first: () => ({ isVisible: async () => false }) }
                if (selector === '#sb_sbi[role="button"]') return { first: () => ({ isVisible: async () => false }) }
                if (selector === '[role="button"]:has(#sbi_b)') return { first: () => trigger }
                if (selector === '#sb_sbidialog[shdlg]') {
                    return { first: () => ({ waitFor: async () => undefined, isVisible: async () => true }) }
                }
                if (selector === '#sb_sbi[aria-expanded="true"]') return { count: async () => 1 }
                if (selector === '.shtip') return { first: () => ({ isVisible: async () => false }) }
                throw new Error(`Unexpected selector: ${selector}`)
            }
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        await (runner as unknown as { waitForControl(): Promise<void>; openDialog(): Promise<void> }).waitForControl()
        await (runner as unknown as { openDialog(): Promise<void> }).openDialog()
        assert.strictEqual(triggerClicks, 1)
    })

    await asyncTest('homepage camera island replaces hidden legacy image trigger', async () => {
        let islandClicks = 0
        const island = { isVisible: async () => true, click: async () => { islandClicks++ } }
        const page = {
            locator: (selector: string) => {
                if (selector === '#sb_cam_island[role="button"]') return { first: () => island }
                if (selector === '#sb_sbidialog[shdlg]') {
                    return { first: () => ({ waitFor: async () => undefined, isVisible: async () => true }) }
                }
                if (selector === '#sb_sbi[aria-expanded="true"]') return { count: async () => 1 }
                if (selector === '.shtip') return { first: () => ({ isVisible: async () => false }) }
                throw new Error(`Unexpected selector: ${selector}`)
            }
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        await (runner as unknown as { waitForControl(): Promise<void>; openDialog(): Promise<void> }).waitForControl()
        await (runner as unknown as { openDialog(): Promise<void> }).openDialog()
        assert.strictEqual(islandClicks, 1)
    })

    await asyncTest('upload prefers filechooser', async () => {
        let chooserPath = ''
        let inputFallbacks = 0
        const page = {
            locator: (selector: string) => {
                if (selector.includes('#sb_brtext')) return { first: () => ({ waitFor: async () => undefined, click: async () => undefined }) }
                if (selector.includes('#sb_fileinput')) return { first: () => ({ count: async () => 1, setInputFiles: async () => { inputFallbacks++ } }) }
                throw new Error(`Unexpected selector: ${selector}`)
            },
            waitForEvent: async () => ({ setFiles: async (file: string) => { chooserPath = file } })
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        await (runner as unknown as { uploadImage(path: string): Promise<void> }).uploadImage('photo.png')
        assert.strictEqual(chooserPath, 'photo.png')
        assert.strictEqual(inputFallbacks, 0)
    })

    await asyncTest('upload falls back to file input once', async () => {
        let inputFallbacks = 0
        const page = {
            locator: (selector: string) => {
                if (selector.includes('#sb_brtext')) return { first: () => ({ waitFor: async () => undefined, click: async () => undefined }) }
                if (selector.includes('#sb_fileinput')) return { first: () => ({ count: async () => 1, setInputFiles: async () => { inputFallbacks++ } }) }
                throw new Error(`Unexpected selector: ${selector}`)
            },
            waitForEvent: async () => null
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        await (runner as unknown as { uploadImage(path: string): Promise<void> }).uploadImage('photo.png')
        assert.strictEqual(inputFallbacks, 1)
    })

    await asyncTest('Final Visual reopens Dashboard and clicks drawer link into popup', async () => {
        const taskUrl = 'https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES'
        const calls: string[] = []
        let popupListenerRegistered = false
        const popup = {
            waitForLoadState: async () => { calls.push('popup-load') },
            url: () => taskUrl,
            close: async () => { calls.push('popup-close') }
        }
        const progress = {
            count: async () => 1,
            getAttribute: async (name: string) => name === 'aria-valuenow' ? '0' : '1'
        }
        const card = {
            isVisible: async () => true,
            locator: () => ({ first: () => progress }),
            click: async () => { calls.push('card-click') }
        }
        const link = {
            isVisible: async () => true,
            getAttribute: async (name: string) => name === 'href' ? taskUrl : null,
            click: async () => {
                assert.strictEqual(popupListenerRegistered, true)
                calls.push('link-click')
            }
        }
        const dashboardPage = {
            goto: async (url: string) => { calls.push(`goto:${url}`) },
            url: () => 'https://rewards.bing.com/dashboard',
            evaluate: async () => undefined,
            locator: (selector: string) => {
                if (selector.includes('search_visual.svg')) return { count: async () => 1, nth: () => card }
                if (selector.includes('vsstreak')) return { count: async () => 1, nth: () => link }
                throw new Error(`Unexpected selector: ${selector}`)
            },
            waitForEvent: async (event: string) => {
                assert.strictEqual(event, 'popup')
                popupListenerRegistered = true
                calls.push('popup-listener')
                return popup
            }
        }
        const detector = new DashboardDetector(dashboardPage as never, async () => undefined)
        const opened = await detector.openTaskPopup(taskUrl, 1000)

        assert.strictEqual(opened, popup)
        assert.deepStrictEqual(calls, [
            'goto:https://rewards.bing.com/dashboard',
            'card-click',
            'popup-listener',
            'link-click',
            'popup-load'
        ])
        assert.strictEqual(calls.includes(`goto:${taskUrl}`), false)
    })

    await asyncTest('Rewards attribution requires reportActivity 2xx', async () => {
        let timeout = 0
        const page = {
            waitForResponse: async (predicate: (response: unknown) => boolean, options: { timeout: number }) => {
                timeout = options.timeout
                assert.strictEqual(predicate({
                    url: () => 'https://www.bing.com/rewardsapp/reportActivity',
                    status: () => 500
                }), false)
                const response = {
                    url: () => 'https://www.bing.com/rewardsapp/reportActivity',
                    status: () => 200
                }
                assert.strictEqual(predicate(response), true)
                return response
            }
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 60_000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        const observed = await (runner as unknown as { waitForAttribution(): Promise<boolean> }).waitForAttribution()
        assert.strictEqual(observed, true)
        assert.strictEqual(timeout, 30_000)
    })

    await asyncTest('result wait requires result URL and ignores early result DOM', async () => {
        const urls = [
            'https://www.bing.com/?features=vsstreak,vstooltip',
            'https://www.bing.com/?features=vsstreak,vstooltip',
            'https://www.bing.com/search?q=sample&bcid=abc&FORM=SBIHMP&hq=1'
        ]
        let urlReads = 0
        let renderChecks = 0
        const page = {
            url: () => urls[Math.min(urlReads++, urls.length - 1)],
            waitForLoadState: async () => undefined,
            evaluate: async () => {
                renderChecks++
                return true
            }
        }
        const runner = new VisualSearchRunner(page as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        })
        const observed = await (runner as unknown as { waitForResult(): Promise<boolean> }).waitForResult()
        assert.strictEqual(observed, true)
        assert.strictEqual(renderChecks, 1)
        assert.ok(urlReads >= 3)
    })

    await asyncTest('result timeout never navigates back to Dashboard verification', async () => {
        let dashboardChecks = 0
        const runner = new VisualSearchRunner({} as never, {
            taskTimeoutMs: 1000,
            completionTimeoutMs: 1000,
            wait: async () => undefined,
            log: () => undefined
        }) as unknown as {
            openTask(): Promise<void>
            waitForControl(): Promise<void>
            openDialog(): Promise<void>
            uploadImage(): Promise<void>
            waitForAttribution(): Promise<boolean>
            waitForResult(): Promise<boolean>
            detector: { verifyCompletion(): Promise<unknown> }
            run(candidate: unknown, imagePath: string): Promise<{ status: string; reason?: string }>
        }
        runner.openTask = async () => undefined
        runner.waitForControl = async () => undefined
        runner.openDialog = async () => undefined
        runner.waitForAttribution = async () => true
        runner.uploadImage = async () => undefined
        runner.waitForResult = async () => false
        runner.detector = {
            verifyCompletion: async () => {
                dashboardChecks++
                return {}
            }
        }

        const result = await runner.run({
            email: 'test@example.com',
            taskUrl: 'https://www.bing.com/?features=vsstreak,vstooltip',
            language: 'en',
            cardBefore: { current: 0, max: 1 },
            drawerBefore: { current: 0, max: 1 }
        }, 'photo.png')
        assert.strictEqual(result.status, 'unconfirmed')
        assert.match(result.reason ?? '', /result page did not appear/)
        assert.strictEqual(dashboardChecks, 0)
    })

    console.log(`Visual Search tests passed: ${passed}`)
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
