import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { load } from 'cheerio'

import { classifyDashboardCard, parseProgress, validateVisualSearchTaskUrl } from '../src/visual-search/DashboardDetector'
import { ImageRepository } from '../src/visual-search/ImageRepository'
import { VisualSearchRunner, isVisualResultUrl } from '../src/visual-search/VisualSearchRunner'
import {
    DEFAULT_VISUAL_SEARCH_CONFIG,
    isVisualSearchComplete,
    resolveVisualSearchConfig,
    validateVisualSearchConfig
} from '../src/visual-search/types'

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
                if (selector === '#sbi_b') return { waitFor: async () => undefined }
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

    console.log(`Visual Search tests passed: ${passed}`)
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
