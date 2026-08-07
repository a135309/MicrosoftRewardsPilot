import { Page } from 'rebrowser-playwright'
import * as readline from 'readline'
import * as crypto from 'crypto'
import { AxiosRequestConfig } from 'axios'

import { MicrosoftRewardsBot } from '../src/index'
import { saveSessionData } from '../utils/Load'
import { HumanBehaviorSimulator } from '../src/anti-detection/human-behavior'

import { OAuth } from '../interfaces/OAuth'
import { AccountLockedError, LoginTimeoutError } from '../interfaces/Errors'

export class Login {
    private bot: MicrosoftRewardsBot
    private readonly emailInputSelector = 'input[type="email"], input[name="loginfmt"], #i0116'
    private readonly passwordInputSelector = 'input[type="password"], #i0118'
    private readonly submitButtonSelector = 'button[type="submit"], input[type="submit"], #idSIButton9'
    private clientId: string = '0000000040170455'
    private authBaseUrl: string = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl: string = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl: string = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope: string = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
    // Flag to prevent spamming passkey logs after first handling
    private passkeyHandled: boolean = false
    private lastNoPromptLog: number = 0
    private noPromptIterations: number = 0
    private humanBehavior: HumanBehaviorSimulator

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.humanBehavior = new HumanBehaviorSimulator()
    }

    private get loginTimeoutMs(): number {
        const configuredTimeout = Number(process.env.LOGIN_TIMEOUT_MS || 30000)
        return Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000
    }

    private isAuthenticatedRewardsUrl(url: URL): boolean {
        const isRewardsHost = url.hostname === 'rewards.bing.com' || url.hostname.endsWith('.rewards.bing.com')
        const pathname = url.pathname.replace(/\/+$/, '') || '/'
        return isRewardsHost && (pathname === '/dashboard' || pathname.startsWith('/dashboard/'))
    }

    private async isAuthenticatedRewardsPage(page: Page, timeout = 0): Promise<boolean> {
        if (this.isAuthenticatedRewardsUrl(new URL(page.url()))) {
            return true
        }
        if (timeout <= 0) {
            return false
        }
        return await page.waitForURL(/rewards\.bing\.com\/dashboard/, { timeout }).then(() => true).catch(() => false)
    }

    private async registerFidoRoute(page: Page): Promise<void> {
        await page.route('**/GetCredentialType.srf*', async (route: any) => {
            const postData = route.request().postData()
            if (!postData) {
                await route.continue()
                return
            }

            try {
                const body = JSON.parse(postData)
                body.isFidoSupported = false
                await route.continue({ postData: JSON.stringify(body) })
            } catch {
                await route.continue()
            }
        }).catch(() => { })
    }

    private async waitForInitialLoginState(page: Page): Promise<void> {
        await Promise.race([
            page.waitForURL(/rewards\.bing\.com\/(dashboard|welcome|signin|createuser)/, { timeout: this.loginTimeoutMs }),
            page.waitForSelector(`${this.emailInputSelector}, ${this.passwordInputSelector}, #userDisplayName`, {
                state: 'visible',
                timeout: this.loginTimeoutMs
            })
        ]).catch(() => { })
    }

    private async hasMicrosoftLoginForm(page: Page): Promise<boolean> {
        return await page.waitForSelector(
            `${this.emailInputSelector}, ${this.passwordInputSelector}, #userDisplayName`,
            { state: 'visible', timeout: 1000 }
        ).then(() => true).catch(() => false)
    }

    private async logLoginDiagnostics(page: Page, phase: string): Promise<void> {
        const emailFieldVisible = await page.locator(this.emailInputSelector).first().isVisible().catch(() => false)
        const passwordFieldVisible = await page.locator(this.passwordInputSelector).first().isVisible().catch(() => false)
        const cookieCount = await page.context().cookies().then(cookies => cookies.length).catch(() => -1)
        const currentUrl = page.url()
        const loggedIn = this.isAuthenticatedRewardsUrl(new URL(currentUrl))
        this.bot.log(
            this.bot.isMobile,
            'LOGIN-STATE',
            `${phase} | URL: ${currentUrl} | loggedIn: ${loggedIn} | emailField: ${emailFieldVisible} | passwordField: ${passwordFieldVisible} | cookies: ${cookieCount}`
        )
    }

    private async promptForInput(question: string): Promise<string> {
        return await new Promise<string>((resolve) => {
            const prompt = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            })

            prompt.question(question, (input) => {
                prompt.close()
                resolve(input)
            })
        })
    }

    async login(page: Page, email: string, password: string, saveSession = true) {

        try {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Starting login process!')

            // Disable FIDO before first navigation so initial credential request is covered.
            await this.registerFidoRoute(page)

            // Navigate to the Bing login page
            await page.goto('https://www.bing.com/rewards/dashboard', { waitUntil: 'domcontentloaded' })
            await this.waitForInitialLoginState(page)

            await page.waitForLoadState('domcontentloaded').catch(() => { })

            await this.bot.browser.utils.reloadBadPage(page)

            // Check if account is locked
            await this.checkAccountLocked(page)

            const currentUrl = new URL(page.url())
            const isLoggedIn = this.isAuthenticatedRewardsUrl(currentUrl)
            const hasLoginForm = await this.hasMicrosoftLoginForm(page)
            await this.logLoginDiagnostics(page, 'Initial login state')

            if (!isLoggedIn) {
                // The anonymous welcome page has no email field — it requires clicking "Sign in"
                // to reach the Microsoft login page first.
                if (currentUrl.pathname === '/welcome') {
                    await this.startSignInFromWelcome(page)
                }
                if (!hasLoginForm && !(await this.hasMicrosoftLoginForm(page))) {
                    await page.goto('https://rewards.bing.com/signin', { waitUntil: 'domcontentloaded' })
                    await this.waitForInitialLoginState(page)
                }
                await this.execLogin(page, email, password)
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Already logged in')

                // Check if account is locked
                await this.checkAccountLocked(page)
            }

            // Check if logged in to bing
            await this.checkBingLogin(page)
            await this.logLoginDiagnostics(page, 'Login completed')

            if (saveSession) {
                await saveSessionData(this.bot.config.sessionPath, page.context(), email, this.bot.isMobile)
            }

            // We're done logging in
            this.bot.log(this.bot.isMobile, 'LOGIN', saveSession
                ? 'Logged in successfully, saved login session!'
                : 'Logged in successfully with read-only session mode')

        } catch (error) {
            // Throw and don't continue
            this.bot.log(this.bot.isMobile, 'LOGIN', 'An error occurred:' + error, 'error')
            throw error
        }
    }

    private async startSignInFromWelcome(page: Page): Promise<void> {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'On Rewards welcome page — clicking "Sign in" to reach the Microsoft login page')
            const signInLink = await page.waitForSelector('#rewards-header-sign-in, #card-footer-sign-in-link', { state: 'visible', timeout: this.loginTimeoutMs }).catch(() => null)
            if (signInLink) {
                await signInLink.click()
            } else {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Sign-in link not found on welcome page; navigating to signin directly', 'warn')
                await page.goto('https://rewards.bing.com/signin', { waitUntil: 'domcontentloaded' })
            }
            // Wait for the Microsoft login page (email field, or password/userDisplayName if prefilled)
            await page.waitForSelector(`${this.emailInputSelector}, ${this.passwordInputSelector}, #userDisplayName`, {
                state: 'visible',
                timeout: this.loginTimeoutMs
            }).catch(() => null)
            await this.bot.utils.wait(1000)
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to start sign-in from welcome page: ${error}`, 'warn')
        }
    }

    private async execLogin(page: Page, email: string, password: string) {
        try {
            await this.enterEmail(page, email)
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.utils.wait(2000)
            await this.enterPassword(page, password)
            await this.bot.utils.wait(2000)

            // 🎯 处理密码提交后出现的 2FA 挑战（Authenticator 数字匹配 / SMS / 邮箱）
            await this.handlePostPasswordTwoFactor(page)

            // 🎯 检查并处理Passkey设置循环（密码输入后可能出现）
            try {
                const passkeyHandled = await this.handlePasskeySetupLoop(page)
                if (passkeyHandled) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Handled Passkey setup after password entry')
                }
            } catch (passkeyError) {
                this.bot.log(this.bot.isMobile, 'LOGIN', `Passkey handling after password: ${passkeyError}`, 'warn')
            }

            // Check if account is locked
            await this.checkAccountLocked(page)

            await this.bot.browser.utils.reloadBadPage(page)
            await this.checkLoggedIn(page)
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'An error occurred: ' + error, 'error')
            throw error
        }
    }

    private async enterEmail(page: Page, email: string) {
        try {
            // Wait for email field
            const emailField = await page.waitForSelector(this.emailInputSelector, { state: 'visible', timeout: this.loginTimeoutMs }).catch(() => null)
            if (!emailField) {
                const emailPrefilled = await page.waitForSelector('#userDisplayName', { timeout: 1000 }).catch(() => null)
                const passwordField = await page.waitForSelector(this.passwordInputSelector, { state: 'visible', timeout: 1000 }).catch(() => null)
                if (emailPrefilled || passwordField) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Email step already completed by Microsoft')
                    return
                }

                throw new Error('Email field not found')
            }

            await this.bot.utils.wait(1000)

            // Check if email is prefilled
            const emailPrefilled = await page.waitForSelector('#userDisplayName', { timeout: 5000 }).catch(() => null)
            if (emailPrefilled) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email already prefilled by Microsoft')
            } else {
                // 🎭 使用人类化打字输入邮箱
                await this.humanBehavior.simulateThinking()
                await page.fill(this.emailInputSelector, '')
                await this.bot.utils.wait(500)
                await this.humanBehavior.humanType(page, email, this.emailInputSelector)
                await this.bot.utils.wait(1000)
            }

            const nextButton = await page.waitForSelector(this.submitButtonSelector, { state: 'visible', timeout: this.loginTimeoutMs }).catch(() => null)
            if (nextButton) {
                // 🎭 使用人类化点击
                await this.humanBehavior.simulateThinking()
                const box = await nextButton.boundingBox()
                if (box) {
                    await this.humanBehavior.humanClick(page, box.x + box.width/2, box.y + box.height/2)
                } else {
                    await nextButton.click()
                }
                await this.bot.utils.wait(2000)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email entered successfully')
            } else {
                const passwordField = await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 2000 }).catch(() => null)
                if (passwordField) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Email step advanced without explicit next button')
                    return
                }

                throw new Error('Next button not found after email entry')
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Email entry failed: ${error}`, 'error')
            throw error
        }
    }

    private async enterPassword(page: Page, password: string) {
        try {
            const viewFooter = await page.waitForSelector('[data-testid="viewFooter"]', { timeout: 2000 }).catch(() => null)
            if (viewFooter) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Page "Get a code to sign in" found by "viewFooter"')

                const otherWaysButton = await viewFooter.$('span[role="button"]')
                if (otherWaysButton) {
                    await otherWaysButton.click()
                    await this.bot.utils.wait(3000)

                    // After "other ways to sign in", the password field is often shown directly. If not,
                    // pick the explicit "Use your password" option. (The previous blind nth(1) list click
                    // could land on the create-account option and navigate to signup.live.com.)
                    const passwordVisible = await page.waitForSelector(this.passwordInputSelector, { state: 'visible', timeout: 3000 }).catch(() => null)
                    if (!passwordVisible) {
                        const usePasswordTexts = ['Use your password', 'パスワードを使用する', '使用密码', '비밀번호 사용', 'Passwort verwenden', 'Utiliser votre mot de passe', 'Usar tu contraseña']
                        for (const t of usePasswordTexts) {
                            const opt = page.locator(`[role="listitem"]:has-text("${t}"), [role="button"]:has-text("${t}")`).first()
                            if (await opt.isVisible().catch(() => false)) {
                                await opt.click().catch(() => { })
                                break
                            }
                        }
                    }
                }
            }

            // Wait for password field
            const passwordField = await page.waitForSelector(this.passwordInputSelector, { state: 'visible', timeout: this.loginTimeoutMs }).catch(() => null)
            if (!passwordField) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Password field not found, possibly 2FA required', 'warn')
                await this.handle2FA(page)
                return
            }

            await this.bot.utils.wait(1000)

            // 🎭 使用人类化密码输入
            await this.humanBehavior.simulateThinking()
            await page.fill(this.passwordInputSelector, '')
            await this.bot.utils.wait(500)
            await this.humanBehavior.humanType(page, password, this.passwordInputSelector)
            await this.bot.utils.wait(1000)

            const nextButton = await page.waitForSelector(this.submitButtonSelector, { state: 'visible', timeout: this.loginTimeoutMs }).catch(() => null)
            if (nextButton) {
                // 🎭 使用人类化点击
                await this.humanBehavior.simulateThinking()
                const box = await nextButton.boundingBox()
                if (box) {
                    await this.humanBehavior.humanClick(page, box.x + box.width/2, box.y + box.height/2)
                } else {
                    await nextButton.click()
                }
                await this.bot.utils.wait(2000)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Password entered successfully')
            } else {
                const loginProgressed = await Promise.race([
                    page.waitForURL(/rewards\.bing\.com\/dashboard/, { timeout: this.loginTimeoutMs }).then(() => true).catch(() => false),
                    page.waitForSelector('input[name="otc"]', { state: 'visible', timeout: 3000 }).then(() => true).catch(() => false),
                    page.waitForSelector('input[name="proofconfirmation"]', { state: 'visible', timeout: 3000 }).then(() => true).catch(() => false),
                    page.waitForSelector('#displaySign, [data-testid="displaySign"]', { state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)
                ])

                if (!loginProgressed) {
                    throw new Error('Next button not found after password entry')
                }
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Password entry failed: ${error}`, 'error')
            throw error
        }
    }

    /**
     * 密码提交后，Microsoft 常会再要求 2FA（Authenticator 数字匹配 / SMS / 邮箱）。
     * enterPassword 仅在“密码框本身缺失”时才路由到 handle2FA，这里补上“密码提交之后”的检测，
     * 只有确实出现 2FA 元素时才进入 handle2FA，避免影响无 2FA 账户的正常流程。
     */
    private async handlePostPasswordTwoFactor(page: Page): Promise<void> {
        try {
            const alreadyIn = await this.isAuthenticatedRewardsPage(page, 2000)
            if (alreadyIn) {
                return
            }

            const twoFAVisible = await Promise.race([
                page.waitForSelector('input[name="otc"]', { state: 'visible', timeout: 4000 }).then(() => true).catch(() => false),
                page.waitForSelector('input[name="proofconfirmation"]', { state: 'visible', timeout: 4000 }).then(() => true).catch(() => false),
                page.waitForSelector('#displaySign, [data-testid="displaySign"]', { state: 'visible', timeout: 4000 }).then(() => true).catch(() => false),
                page.waitForSelector('button[aria-describedby="confirmSendTitle"]', { state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
            ])

            if (twoFAVisible) {
                this.bot.log(this.bot.isMobile, 'LOGIN', '2FA challenge detected after password entry — handling')
                await this.handle2FA(page)
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Post-password 2FA detection failed: ${error}`, 'warn')
        }
    }

    private async handle2FA(page: Page) {
        try {
            // 等待页面加载完成
            await this.bot.utils.wait(3000)
            
            // 检测2FA冲突 - 如果是并行模式，添加随机延迟避免冲突
            if (this.bot.config.parallel) {
                const randomDelay = Math.floor(Math.random() * 10000) + 5000 // 5-15秒随机延迟
                this.bot.log(this.bot.isMobile, 'LOGIN', `Parallel mode detected, waiting ${randomDelay/1000}s to avoid 2FA conflicts`)
                await this.bot.utils.wait(randomDelay)
            }
            
            // 检查是否已经登录成功（可能其他实例已完成登录）
            const isLoggedIn = await this.isAuthenticatedRewardsPage(page, 3000)
            if (isLoggedIn) {
                this.bot.log(this.bot.isMobile, 'LOGIN', '2FA not required - already logged in')
                return
            }
            
            // 记录当前页面状态
            const currentUrl = page.url()
            this.bot.log(this.bot.isMobile, 'LOGIN', `Current page URL: ${currentUrl}`)
            
            // 检查是否有SMS验证选项
            const smsOption = await page.waitForSelector('input[name="otc"]', { state: 'visible', timeout: 3000 }).catch(() => null)
            if (smsOption) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'SMS verification detected')
                await this.authSMSVerification(page)
                return
            }
            
            // 检查是否有邮箱验证选项
            const emailOption = await page.waitForSelector('input[name="proofconfirmation"]', { state: 'visible', timeout: 3000 }).catch(() => null)
            if (emailOption) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Email verification detected - manual intervention required')
                await this.authEmailVerification(page)
                return
            }
            
            // 尝试获取Authenticator App验证码
            const numberToPress = await this.get2FACode(page)
            if (numberToPress) {
                // 检查是否有并行2FA冲突
                if (this.bot.config.parallel) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Parallel mode: Multiple 2FA requests may cause conflicts', 'warn')
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'If verification fails, try running accounts individually', 'warn')
                }
                
                // Authentictor App verification
                await this.authAppVerification(page, numberToPress)
            } else {
                // 如果在移动端，尝试特殊处理
                if (this.bot.isMobile) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Mobile 2FA: No display code found, trying mobile-specific handling...')
                    
                    // 尝试检测并处理移动端特有的2FA页面
                    const mobile2FAHandled = await this.handleMobile2FAPage(page)
                    if (mobile2FAHandled) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Mobile 2FA handled successfully')
                        return
                    }
                    
                    // 如果是并行模式，可能桌面端已经处理了2FA
                    if (this.bot.config.parallel) {
                        this.bot.log(this.bot.isMobile, 'LOGIN', 'Parallel mode: Desktop may have handled 2FA, waiting...', 'warn')
                        await this.bot.utils.wait(10000) // 等待10秒
                        
                        // 再次检查是否已登录
                        const isNowLoggedIn = await this.isAuthenticatedRewardsPage(page, 5000)
                        if (isNowLoggedIn) {
                            this.bot.log(this.bot.isMobile, 'LOGIN', 'Login completed by parallel process')
                            return
                        }
                    }
                    
                    throw new Error('Mobile 2FA authentication method not supported - OAuth token may be required')
                } else {
                    // 桌面端找不到2FA验证码
                    this.bot.log(this.bot.isMobile, 'LOGIN', 'Desktop 2FA: No verification method detected')
                    
                    // 检查是否有其他2FA选项
                    await this.tryAlternative2FAMethods(page)
                }
            }
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `2FA handling failed: ${error}`, 'error')
            throw error
        }
    }

    private async authEmailVerification(page: Page) {
        this.bot.log(this.bot.isMobile, 'LOGIN', 'Email verification required. Please check your email and enter the code.')

        const code = await this.promptForInput('Enter email verification code:\n')

        await page.fill('input[name="proofconfirmation"]', code)
        await page.keyboard.press('Enter')
        this.bot.log(this.bot.isMobile, 'LOGIN', 'Email verification code entered successfully')
    }

    private async get2FACode(page: Page): Promise<string | null> {
        try {
            // 首先等待页面稳定
            await this.bot.utils.wait(2000)
            
            // 检查是否存在认证码按钮，如果存在先点击
            const sendCodeButton = await page.waitForSelector('button[aria-describedby="confirmSendTitle"]', { state: 'visible', timeout: 3000 }).catch(() => null)
            if (sendCodeButton) {
                await sendCodeButton.click()
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked send code button')
                await this.bot.utils.wait(3000)
            }
            
            // 增加超时时间到10秒，并尝试多个选择器
            const selectors = [
                '#displaySign',
                'div[data-testid="displaySign"]>span',
                '[data-testid="displaySign"]',
                'span[aria-label*="verification"]',
                '.display-sign-container span'
            ]
            
            let element = null
            for (const selector of selectors) {
                element = await page.waitForSelector(selector, { state: 'visible', timeout: 3000 }).catch(() => null)
                if (element) {
                    this.bot.log(this.bot.isMobile, 'LOGIN', `Found 2FA code element with selector: ${selector}`)
                    break
                }
            }
            
            if (element) {
                const code = await element.textContent()
                this.bot.log(this.bot.isMobile, 'LOGIN-2FA-CODE', `2FA code found: ${code}`)
                return code
            }
            
            // 如果找不到验证码显示元素，可能是其他类型的2FA
            this.bot.log(this.bot.isMobile, 'LOGIN', 'No 2FA code display element found, checking for other 2FA methods')
            return null
            
        } catch (error) {
            // 如果是并行模式，处理特殊情况
            if (this.bot.config.parallel) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Script running in parallel, can only send 1 2FA request per account at a time!', 'log', 'yellow')
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Trying again in 60 seconds! Please wait...', 'log', 'yellow')

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const button = await page.waitForSelector('button[aria-describedby="pushNotificationsTitle errorDescription"]', { state: 'visible', timeout: 2000 }).catch(() => null)
                    if (button) {
                        await this.bot.utils.wait(60000)
                        await button.click()
                        continue
                    } else {
                        break
                    }
                }
                
                // 重试获取验证码
                return await this.get2FACode(page)
            }
            
            this.bot.log(this.bot.isMobile, 'LOGIN', `Failed to get 2FA code: ${error}`)
            return null
        }
    }

    private async authAppVerification(page: Page, numberToPress: string | null) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                this.bot.log(this.bot.isMobile, 'LOGIN-2FA-CODE', `Press the number ${numberToPress} on your Authenticator app to approve the login`)
                this.bot.log(this.bot.isMobile, 'LOGIN', 'If you press the wrong number or the "DENY" button, try again in 60 seconds')

                await page.waitForSelector('form[name="f1"]', { state: 'detached', timeout: 60000 })

                this.bot.log(this.bot.isMobile, 'LOGIN', 'Login successfully approved!')
                break
            } catch {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'The code is expired. Trying to get a new code...')
                await page.click('button[aria-describedby="pushNotificationsTitle errorDescription"]')
                numberToPress = await this.get2FACode(page)
            }
        }
    }

    private async authSMSVerification(page: Page) {
        this.bot.log(this.bot.isMobile, 'LOGIN', 'SMS 2FA code required. Waiting for user input...')

        const code = await this.promptForInput('Enter 2FA code:\n')

        await page.fill('input[name="otc"]', code)
        await page.keyboard.press('Enter')
        this.bot.log(this.bot.isMobile, 'LOGIN', '2FA code entered successfully')
    }

    private async tryAlternative2FAMethods(page: Page) {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN', 'Trying alternative 2FA methods...')
            
            // 检查是否有"使用其他方法"链接
            const otherMethodsLink = await page.waitForSelector('a:has-text("Use a different method"), button:has-text("Use a different method")', { timeout: 3000 }).catch(() => null)
            if (otherMethodsLink) {
                await otherMethodsLink.click()
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked "Use a different method"')
                await this.bot.utils.wait(3000)
                
                // 重新尝试检测2FA方法
                const newNumberToPress = await this.get2FACode(page)
                if (newNumberToPress) {
                    await this.authAppVerification(page, newNumberToPress)
                    return
                }
            }
            
            // 检查是否有继续按钮
            const continueButton = await page.waitForSelector('button[type="submit"], input[type="submit"]', { timeout: 3000 }).catch(() => null)
            if (continueButton) {
                await continueButton.click()
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Clicked continue button')
                await this.bot.utils.wait(3000)
                return
            }
            
            // 检查是否有密码重新验证选项
            const passwordField = await page.waitForSelector('input[type="password"]', { timeout: 3000 }).catch(() => null)
            if (passwordField) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Password re-verification required', 'warn')
                throw new Error('Password re-verification required - manual intervention needed')
            }
            
            this.bot.log(this.bot.isMobile, 'LOGIN', 'No alternative 2FA methods found', 'warn')
            
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Alternative 2FA methods failed: ${error}`, 'error')
            throw error
        }
    }

    async getMobileAccessToken(page: Page, email: string): Promise<OAuth> {
        const authorizeUrl = new URL(this.authBaseUrl)

        authorizeUrl.searchParams.append('response_type', 'code')
        authorizeUrl.searchParams.append('client_id', this.clientId)
        authorizeUrl.searchParams.append('redirect_uri', this.redirectUrl)
        authorizeUrl.searchParams.append('scope', this.scope)
        authorizeUrl.searchParams.append('state', crypto.randomBytes(16).toString('hex'))
        authorizeUrl.searchParams.append('access_type', 'offline_access')
        authorizeUrl.searchParams.append('login_hint', email)

        // Disable FIDO for OAuth flow as well (reduces passkey prompts resurfacing)
        await this.registerFidoRoute(page)

        await page.goto(authorizeUrl.href)

        let currentUrl = new URL(page.url())
        let code: string

        const authStart = Date.now()
        const maxWaitMs = Number(process.env.MOBILE_OAUTH_TIMEOUT_MS || 180000)
        this.bot.log(this.bot.isMobile, 'LOGIN-APP', 'Waiting for authorization...')
        // eslint-disable-next-line no-constant-condition
        while (true) {
            // Attempt to dismiss passkey/passkey-like screens quickly (non-blocking)
            await this.tryDismissPasskeyPrompt(page)
            if (currentUrl.hostname === 'login.live.com' && currentUrl.pathname === '/oauth20_desktop.srf') {
                code = currentUrl.searchParams.get('code')!
                break
            }

            currentUrl = new URL(page.url())
            // Shorter wait to react faster to passkey prompt
            await this.bot.utils.wait(1000)

            const elapsed = Date.now() - authStart
            if (elapsed > maxWaitMs) {
                throw new LoginTimeoutError(`OAuth authorization timeout after ${Math.round(elapsed / 1000)}s`)
            }
        }

        const body = new URLSearchParams()
        body.append('grant_type', 'authorization_code')
        body.append('client_id', this.clientId)
        body.append('code', code)
        body.append('redirect_uri', this.redirectUrl)

        const tokenRequest: AxiosRequestConfig = {
            url: this.tokenUrl,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: body.toString()
        }

        const tokenResponse = await this.bot.axios.request(tokenRequest)
        const tokenData: OAuth = await tokenResponse.data

        const authDuration = Date.now() - authStart
        this.bot.log(this.bot.isMobile, 'LOGIN-APP', `Successfully authorized in ${Math.round(authDuration/1000)}s`)
        return tokenData
    }

    // Utils

    private async checkLoggedIn(page: Page) {
        const start = Date.now()
        const maxWaitMs = Number(process.env.LOGIN_MAX_WAIT_MS || 180000) // default 3 minutes
        let guidanceLogged = false
        let dashboardRecoveryAttempted = false

        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (page.url().toLowerCase().includes('/fido/create')) {
                const passkeyHandled = await this.attemptPasskeySkip(page)
                if (passkeyHandled) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'FIDO creation dialog cancelled; continuing login')
                }
            }
            await this.dismissLoginMessages(page)
            let currentUrl = new URL(page.url())
            if (this.isAuthenticatedRewardsUrl(currentUrl)) {
                break
            }

            const currentPath = currentUrl.pathname.replace(/\/+$/, '') || '/'
            const onRewardsAbout = (currentUrl.hostname === 'rewards.bing.com' || currentUrl.hostname.endsWith('.rewards.bing.com'))
                && currentPath === '/about'
            if (onRewardsAbout && !dashboardRecoveryAttempted) {
                dashboardRecoveryAttempted = true
                this.bot.log(this.bot.isMobile, 'LOGIN-RECOVERY', 'Post-login About page detected; navigating to dashboard')
                try {
                    await page.goto('https://rewards.bing.com/dashboard', {
                        waitUntil: 'domcontentloaded',
                        timeout: this.loginTimeoutMs
                    })
                } catch (error) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-RECOVERY', `Dashboard navigation failed: ${error}`, 'warn')
                }

                currentUrl = new URL(page.url())
                if (this.isAuthenticatedRewardsUrl(currentUrl)) {
                    break
                }
            }

            // If we keep looping without prompts for too long, advise and fail fast
            const elapsed = Date.now() - start
            if (elapsed > maxWaitMs) {
                if (!guidanceLogged) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-GUIDE', 'Login taking too long without prompts.')
                    this.bot.log(this.bot.isMobile, 'LOGIN-GUIDE', 'Tip: Enable passwordless sign-in (Microsoft Authenticator "number match") or add a TOTP secret in accounts.json to auto-fill OTP.')
                    this.bot.log(this.bot.isMobile, 'LOGIN-GUIDE', 'You can also set LOGIN_MAX_WAIT_MS to increase this timeout if needed.')
                    guidanceLogged = true
                }
                this.bot.log(this.bot.isMobile, 'LOGIN-TIMEOUT', `Login timed out after ${Math.round(elapsed/1000)}s without completing`, 'error')
                throw new Error(`Login timed out after ${Math.round(elapsed/1000)}s without completing`)
            }
        }

        // Allow the dashboard SPA to settle (the old RewardsPortal DOM marker no longer exists)
        await this.bot.utils.wait(2000)
        await this.logLoginDiagnostics(page, 'Authenticated dashboard')
        this.bot.log(this.bot.isMobile, 'LOGIN', 'Successfully logged into the rewards portal')

        // 🎯 处理Passkey设置循环问题
        try {
            const passkeyHandled = await this.handlePasskeySetupLoop(page)
            if (passkeyHandled) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Successfully bypassed Passkey setup loop')
            }
        } catch (passkeyError) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Passkey handling warning: ${passkeyError}`, 'warn')
        }

        // 🎯 登录成功后检查并处理弹窗
        try {
            const handledPopups = await this.bot.browser.utils.handleRewardsPopups(page)
            if (handledPopups) {
                this.bot.log(this.bot.isMobile, 'LOGIN', 'Handled popups after successful login')
            }
        } catch (popupError) {
            this.bot.log(this.bot.isMobile, 'LOGIN', `Popup handling warning after login: ${popupError}`, 'warn')
        }
    }

    /**
     * 处理Passkey设置循环问题
     * Microsoft有时会强制显示Passkey设置页面，需要多种方式绕过
     */
    private async handlePasskeySetupLoop(page: Page): Promise<boolean> {
        // 检查是否启用Passkey处理
        if (this.bot.config?.passkeyHandling?.enabled === false) {
            return false
        }

        const maxAttempts = this.bot.config?.passkeyHandling?.maxAttempts || 5
        let attempts = 0

        while (attempts < maxAttempts) {
            attempts++

            try {
                // 检查是否在Passkey设置页面
                const isPasskeyPage = await this.isPasskeySetupPage(page)
                if (!isPasskeyPage) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Not on Passkey setup page, continuing')
                    return false
                }

                this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Detected Passkey setup page (attempt ${attempts}/${maxAttempts})`)

                // 尝试多种跳过方法
                const skipped = await this.attemptPasskeySkip(page)
                if (skipped) {
                    // 等待页面跳转
                    await page.waitForTimeout(3000)

                    // 检查是否成功跳过
                    const stillOnPasskey = await this.isPasskeySetupPage(page)
                    if (!stillOnPasskey) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Successfully skipped Passkey setup')
                        return true
                    } else {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Still on Passkey page after skip attempt', 'warn')
                    }
                } else {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Failed to find skip option', 'warn')
                }

                // 短暂等待后重试
                await page.waitForTimeout(2000)

            } catch (error) {
                this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Passkey handling error: ${error}`, 'warn')
            }
        }

        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Failed to bypass Passkey setup after ${maxAttempts} attempts`, 'error')
        return false
    }

    /**
     * 检查是否在Passkey设置页面
     */
    private async isPasskeySetupPage(page: Page): Promise<boolean> {
        try {
            // 检查URL特征
            const url = page.url().toLowerCase()
            if (url.includes('/fido/create') || url.includes('passkey') || url.includes('webauthn')) {
                return true
            }

            // 检查页面内容特征
            const passkeyTexts = [
                'Set up a passkey',
                'Create a passkey',
                'passkey',
                'Passkey',
                'Skip for now',
                'Maybe later'
            ]

            for (const text of passkeyTexts) {
                try {
                    const element = await page.waitForSelector(`text=${text}`, { timeout: 1000 }).catch(() => null)
                    if (element) {
                        return true
                    }
                } catch {
                    continue
                }
            }

            return false
        } catch {
            return false
        }
    }

    /**
     * 尝试跳过Passkey设置
     */
    private async attemptPasskeySkip(page: Page): Promise<boolean> {
        const cancelSelectors = [
            'button:has-text("Cancel")',
            'button:has-text("取消")',
            'input[type="button"][value="Cancel"]',
            'input[type="button"][value="取消"]',
            '[data-testid="cancelButton"]'
        ]

        for (const selector of cancelSelectors) {
            const cancelButton = await page.waitForSelector(selector, { state: 'visible', timeout: 1000 }).catch(() => null)
            if (cancelButton) {
                this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `FIDO creation dialog detected -> clicked cancel: ${selector}`)
                await cancelButton.click()
                await page.waitForTimeout(500)
                return true
            }
        }
        // 跳过按钮的选择器（使用更安全的属性选择器）
        const skipSelectors = [
            '[data-testid="secondaryButton"]', // Microsoft常用的次要按钮
            'button[value*="skip"]',
            'button[aria-label*="skip"]',
            'button[data-action="skip"]',
            '.skip-button',
            '#skip-button',
            'button[value="跳过"]',
            'button[value="スキップ"]'
        ]

        for (const selector of skipSelectors) {
            try {
                const element = await page.waitForSelector(selector, {
                    state: 'visible',
                    timeout: 2000
                }).catch(() => null)

                if (element) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Found skip button: ${selector}`)
                    await element.click()
                    await page.waitForTimeout(1000)
                    return true
                }
            } catch {
                continue
            }
        }

        // 尝试ESC键
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Trying ESC key to skip Passkey setup')
            await page.keyboard.press('Escape')
            await page.waitForTimeout(1000)
            return true
        } catch {
            // ESC失败
        }

        // 最后尝试直接导航
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Attempting direct navigation to rewards page')
            await page.goto('https://rewards.bing.com', { waitUntil: 'networkidle' })
            await page.waitForTimeout(2000)
            return true
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Direct navigation failed: ${error}`, 'warn')
        }

        return false
    }

    private isNavigationRaceError(error: unknown): boolean {
        return String(error).includes('Execution context was destroyed')
    }

    private async dismissLoginMessages(page: Page) {
        try {
            await this.dismissLoginMessagesOnce(page)
        } catch (error) {
            if (!this.isNavigationRaceError(error)) {
                throw error
            }

            this.bot.log(this.bot.isMobile, 'LOGIN-NAVIGATION', 'Page navigated while checking login dialogs; continuing with new page state')
        }
    }

    private async dismissLoginMessagesOnce(page: Page) {
        let didSomething = false

        // PASSKEY / Windows Hello / Sign in faster
        const passkeyVideo = await page.waitForSelector('[data-testid="biometricVideo"]', { timeout: 1000 }).catch(() => null)
        if (passkeyVideo) {
            const skipButton = await page.$('button[data-testid="secondaryButton"]')
            if (skipButton) {
                await skipButton.click().catch(()=>{})
                if (!this.passkeyHandled) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Passkey dialog detected (video heuristic) -> clicked "Skip for now"')
                }
                this.passkeyHandled = true
                await page.waitForTimeout(300)
                didSomething = true
            }
        }
        if (!didSomething) {
            const titleEl = await page.waitForSelector('[data-testid="title"]', { timeout: 800 }).catch(() => null)
            const titleText = (titleEl ? (await titleEl.textContent()) : '')?.trim() || ''
            const looksLikePasskey = /sign in faster|passkey|fingerprint|face|pin/i.test(titleText)
            const secondaryBtn = await page.waitForSelector('button[data-testid="secondaryButton"]', { timeout: 500 }).catch(() => null)
            const primaryBtn = await page.waitForSelector('button[data-testid="primaryButton"]', { timeout: 500 }).catch(() => null)
            if (looksLikePasskey && secondaryBtn) {
                await secondaryBtn.click().catch(()=>{})
                if (!this.passkeyHandled) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Passkey dialog detected (title: "${titleText}") -> clicked secondary`)
                }
                this.passkeyHandled = true
                await page.waitForTimeout(300)
                didSomething = true
            } else if (!didSomething && secondaryBtn && primaryBtn) {
                const secText = (await secondaryBtn.textContent() || '').trim()
                if (/skip for now/i.test(secText)) {
                    await secondaryBtn.click().catch(()=>{})
                    if (!this.passkeyHandled) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Passkey dialog (pair heuristic) -> clicked secondary (Skip for now)')
                    }
                    this.passkeyHandled = true
                    await page.waitForTimeout(300)
                    didSomething = true
                }
            }
            if (!didSomething) {
                const skipByText = await page.locator('xpath=//button[contains(normalize-space(.), "Skip for now")]').first()
                if (await skipByText.isVisible().catch(()=>false)) {
                    await skipByText.click().catch(()=>{})
                    if (!this.passkeyHandled) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Passkey dialog (text fallback) -> clicked "Skip for now"')
                    }
                    this.passkeyHandled = true
                    await page.waitForTimeout(300)
                    didSomething = true
                }
            }
            if (!didSomething) {
                const closeBtn = await page.$('#close-button')
                if (closeBtn) {
                    await closeBtn.click().catch(()=>{})
                    if (!this.passkeyHandled) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Attempted close button on potential passkey modal')
                    }
                    this.passkeyHandled = true
                    await page.waitForTimeout(300)
                }
            }
        }

        // KMSI ("Stay signed in?" / Keep me signed in) prompt — handle the classic kmsiVideo variant
        // AND the newer text-based one (button[type=submit] はい/Yes, no stable id/data-testid).
        if (!didSomething) {
            const kmsiClassic = await page.$('[data-testid="kmsiVideo"]').catch(() => null)
            const pageTitle = await page.title().catch(() => '')
            const titleEl2 = await page.$('[data-testid="title"], #loginHeader').catch(() => null)
            const titleTxt = ((titleEl2 ? (await titleEl2.textContent().catch(() => '')) : '') || '') + ' ' + pageTitle
            const looksLikeKmsi = !!kmsiClassic || /stay signed in|keep me signed|サインインの状態を維持|保持登录状态|로그인 상태 유지|angemeldet bleiben|rester connecté/i.test(titleTxt)
            if (looksLikeKmsi) {
                let clicked = false
                for (const sel of ['#idSIButton9', 'button[data-testid="primaryButton"]']) {
                    const btn = await page.$(sel).catch(() => null)
                    if (btn) { await btn.click().catch(() => { }); clicked = true; break }
                }
                if (!clicked) {
                    for (const t of ['はい', 'Yes', '是', '예', 'Ja', 'Oui', 'Sí']) {
                        const btn = page.locator(`button[type="submit"]:has-text("${t}"), button:has-text("${t}")`).first()
                        if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => { }); clicked = true; break }
                    }
                }
                if (clicked) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-KMSI', 'KMSI "Stay signed in?" detected -> accepted (Yes)')
                    await page.waitForTimeout(500)
                    didSomething = true
                }
            }
        }

        if (!didSomething) {
            this.noPromptIterations++
            const now = Date.now()
            if (this.noPromptIterations === 1 || (now - this.lastNoPromptLog) > 10000) {
                this.lastNoPromptLog = now
                this.bot.log(this.bot.isMobile, 'LOGIN-NO-PROMPT', `No dialogs (x${this.noPromptIterations}) | page: "${await page.title().catch(() => '')}"`)
                // Reset counter if it grows large to keep number meaningful
                if (this.noPromptIterations > 50) this.noPromptIterations = 0
            }
        } else {
            // Reset counters after an interaction
            this.noPromptIterations = 0
        }
    }

    /** Lightweight passkey prompt dismissal used in mobile OAuth loop */
    private async tryDismissPasskeyPrompt(page: Page) {
        try {
            // Fast existence checks with very small timeouts to avoid slowing the loop
            const titleEl = await page.waitForSelector('[data-testid="title"]', { timeout: 500 }).catch(() => null)
            const secondaryBtn = await page.waitForSelector('button[data-testid="secondaryButton"]', { timeout: 500 }).catch(() => null)
            // Direct text locator fallback (sometimes data-testid changes)
            const textSkip = page.locator('xpath=//button[contains(normalize-space(.), "Skip for now")]').first()
            if (secondaryBtn) {
                // Heuristic: if title indicates passkey or both primary/secondary exist with typical text
                let shouldClick = false
                let titleText = ''
                if (titleEl) {
                    titleText = (await titleEl.textContent() || '').trim()
                    if (/sign in faster|passkey|fingerprint|face|pin/i.test(titleText)) {
                        shouldClick = true
                    }
                }
                if (!shouldClick) {
                    // Fallback text probe on the secondary button itself
                    const btnText = (await secondaryBtn.textContent() || '').trim()
                    if (/skip for now/i.test(btnText)) {
                        shouldClick = true
                    }
                }
                if (shouldClick) {
                    await secondaryBtn.click().catch(() => { })
                    if (!this.passkeyHandled) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', `Passkey prompt (loop) -> clicked skip${titleText ? ` (title: ${titleText})` : ''}`)
                    }
                    this.passkeyHandled = true
                    await this.bot.utils.wait(500)
                }
            } else if (await textSkip.isVisible().catch(() => false)) {
                await textSkip.click().catch(() => { })
                if (!this.passkeyHandled) {
                    this.bot.log(this.bot.isMobile, 'LOGIN-PASSKEY', 'Passkey prompt (loop) -> clicked text fallback')
                }
                this.passkeyHandled = true
                await this.bot.utils.wait(500)
            }
        } catch { /* ignore minor errors */ }
    }

    private async checkBingLogin(page: Page): Promise<void> {
        try {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Verifying Bing login')
            await page.goto('https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F', { waitUntil: 'domcontentloaded' })

            const maxIterations = 5
            let verified = false

            for (let iteration = 1; iteration <= maxIterations; iteration++) {
                const currentUrl = new URL(page.url())

                const isBingHost = currentUrl.hostname === 'bing.com' || currentUrl.hostname.endsWith('.bing.com')

                if (isBingHost) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    const loggedIn = await this.checkBingLoginStatus(page)
                    if (loggedIn) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'Bing login verification passed!')
                        verified = true
                        break
                    }
                }

                await this.bot.utils.wait(1000)
            }

            if (!verified) {
                throw new Error('Bing login verification failed')
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN-BING', 'An error occurred:' + error, 'error')
            throw error
        }
    }

    private async checkBingLoginStatus(page: Page): Promise<boolean> {
        const cookies = await page.context().cookies('https://www.bing.com/').catch(() => [])
        const hasAuthenticatedBingCookie = cookies.some(cookie => cookie.name === '_U' && cookie.value.length > 0)
        if (hasAuthenticatedBingCookie) {
            return true
        }

        return await page.waitForSelector('#id_n', { state: 'visible', timeout: 2000 })
            .then(() => true)
            .catch(() => false)
    }

    private async checkAccountLocked(page: Page) {
        await this.bot.utils.wait(2000)
        const isLocked = await page.waitForSelector('#serviceAbuseLandingTitle', { state: 'visible', timeout: 1000 }).then(() => true).catch(() => false)
        if (isLocked) {
            this.bot.log(this.bot.isMobile, 'CHECK-LOCKED', 'This account has been locked! Remove the account from "accounts.json" and restart!', 'error')
            throw new AccountLockedError('This account has been locked! Remove the account from "accounts.json" and restart!')
        }
    }

    private async handleMobile2FAPage(page: Page): Promise<boolean> {
        try {
            const currentUrl = page.url()
            this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', `Handling mobile 2FA page: ${currentUrl}`)
            
            // 在并行模式下，等待一些时间避免与桌面端冲突
            if (this.bot.config.parallel) {
                this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Parallel mode: Adding delay to avoid conflicts with desktop 2FA')
                await this.bot.utils.wait(5000)
            }
            
            // 尝试查找移动端特有的2FA元素
            const mobile2FAElements = [
                'input[name="otc"]', // SMS验证码
                'input[name="proofconfirmation"]', // 邮箱验证码
                '#displaySign', // Authenticator显示号码
                '[data-testid="displaySign"]', // 新版Authenticator显示
                'div:has-text("Enter the number shown")', // 移动端Authenticator提示
                'div:has-text("Use your authenticator app")' // Authenticator应用提示
            ]
            
            let foundElement = null
            let elementType = ''
            
            for (const selector of mobile2FAElements) {
                const element = await page.waitForSelector(selector, { state: 'visible', timeout: 2000 }).catch(() => null)
                if (element) {
                    foundElement = element
                    elementType = selector
                    this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', `Found mobile 2FA element: ${selector}`)
                    break
                }
            }
            
            if (foundElement) {
                if (elementType.includes('otc')) {
                    // SMS验证
                    this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'SMS verification detected - requires manual input', 'warn')
                    await this.authSMSVerification(page)
                    return true
                } else if (elementType.includes('proofconfirmation')) {
                    // 邮箱验证
                    this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Email verification detected - requires manual input', 'warn')
                    await this.authEmailVerification(page)
                    return true
                } else if (elementType.includes('displaySign') || elementType.includes('Enter the number')) {
                    // Authenticator App验证
                    const code = await foundElement.textContent()
                    if (code && code.trim()) {
                        this.bot.log(this.bot.isMobile, 'LOGIN-2FA-CODE', `Found Authenticator code on mobile: ${code}`)
                        
                        // 检查是否与桌面端代码冲突
                        if (this.bot.config.parallel) {
                            this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Parallel mode: Mobile Authenticator code may conflict with desktop', 'warn')
                        }
                        
                        await this.authAppVerification(page, code.trim())
                        return true
                    }
                }
            }
            
            // 检查是否是passkey页面
            if (currentUrl.includes('passkey')) {
                this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Detected passkey authentication page')
                
                // 查找跳过按钮
                const skipButtons = [
                    'button[data-testid="secondaryButton"]',
                    'a:has-text("Use a different method")',
                    'button:has-text("Skip")',
                    'a:has-text("Skip")',
                    '[data-testid="alternativeVerificationMethodLink"]'
                ]
                
                for (const selector of skipButtons) {
                    const button = await page.waitForSelector(selector, { timeout: 2000 }).catch(() => null)
                    if (button) {
                        await button.click()
                        this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', `Clicked skip button: ${selector}`)
                        await this.bot.utils.wait(2000)
                        return true
                    }
                }
            }
            
            // 检查是否有其他验证方法选项
            const otherMethodsButton = await page.waitForSelector('button:has-text("Use a different method"), a:has-text("Use a different method")', { timeout: 3000 }).catch(() => null)
            if (otherMethodsButton) {
                await otherMethodsButton.click()
                this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Clicked "Use a different method"')
                await this.bot.utils.wait(2000)
                
                // 查找密码验证选项
                const passwordOption = await page.waitForSelector('span:has-text("Password"), div:has-text("Password")', { timeout: 3000 }).catch(() => null)
                if (passwordOption) {
                    await passwordOption.click()
                    this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Selected password verification option')
                    await this.bot.utils.wait(2000)
                    return true
                }
            }
            
            // 检查是否已经可以继续（有时页面会自动跳过）
            const isRewardsPage = await this.isAuthenticatedRewardsPage(page, 2000)
            if (isRewardsPage) {
                this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', 'Already on rewards page - 2FA passed')
                return true
            }
            
            // 检查是否有继续按钮
            const continueButtons = [
                'button[type="submit"]',
                'button:has-text("Continue")',
                'button:has-text("Next")',
                'input[type="submit"]'
            ]
            
            for (const selector of continueButtons) {
                const button = await page.waitForSelector(selector, { timeout: 2000 }).catch(() => null)
                if (button && await button.isVisible()) {
                    await button.click()
                    this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', `Clicked continue button: ${selector}`)
                    await this.bot.utils.wait(2000)
                    return true
                }
            }
            
            return false
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'LOGIN-MOBILE-2FA', `Mobile 2FA handling failed: ${error}`, 'warn')
            return false
        }
    }
}
