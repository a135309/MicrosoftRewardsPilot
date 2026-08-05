import * as assert from 'assert'

import { Login } from '../functions/Login'

type Cookie = { name: string; value: string }

function createPage(cookies: Cookie[], legacyMarkerVisible: boolean) {
    return {
        context: () => ({
            cookies: async () => cookies
        }),
        waitForSelector: async () => {
            if (!legacyMarkerVisible) {
                throw new Error('selector not found')
            }
            return {}
        }
    }
}

async function testDashboardRecovery(): Promise<void> {
    const login = Object.create(Login.prototype) as Login
    const testLogin = login as unknown as {
        bot: unknown
        dismissLoginMessages: () => Promise<void>
        logLoginDiagnostics: () => Promise<void>
        handlePasskeySetupLoop: () => Promise<boolean>
        checkLoggedIn: (page: unknown) => Promise<void>
    }

    testLogin.bot = {
        isMobile: false,
        log: () => undefined,
        utils: { wait: async () => undefined },
        browser: { utils: { handleRewardsPopups: async () => false } }
    }
    testLogin.dismissLoginMessages = async () => undefined
    testLogin.logLoginDiagnostics = async () => undefined
    testLogin.handlePasskeySetupLoop = async () => false

    let currentUrl = 'https://rewards.bing.com/about'
    let dashboardVisits = 0
    const page = {
        url: () => currentUrl,
        goto: async (url: string) => {
            dashboardVisits++
            currentUrl = url
        }
    }

    await testLogin.checkLoggedIn(page)
    assert.strictEqual(dashboardVisits, 1, 'post-login About page should navigate to dashboard once')
}

async function run(): Promise<void> {
    const login = Object.create(Login.prototype) as Login
    const checkBingLoginStatus = (login as unknown as {
        checkBingLoginStatus: (page: unknown) => Promise<boolean>
    }).checkBingLoginStatus.bind(login)

    assert.strictEqual(
        await checkBingLoginStatus(createPage([{ name: '_U', value: 'authenticated' }], false)),
        true,
        'authenticated Bing cookie should pass verification'
    )
    assert.strictEqual(
        await checkBingLoginStatus(createPage([], true)),
        true,
        'legacy Bing account marker should remain a fallback'
    )
    assert.strictEqual(
        await checkBingLoginStatus(createPage([], false)),
        false,
        'missing cookie and marker should fail verification'
    )
    await testDashboardRecovery()
}

run().then(() => {
    console.log('Login verification tests passed')
}).catch(error => {
    console.error(error)
    process.exitCode = 1
})
