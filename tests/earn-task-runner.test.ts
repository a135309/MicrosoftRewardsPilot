import assert from 'assert'

import {
    buildEarnTaskSnapshots,
    hasEarnCompletedMarker,
    isQuestActionLink,
    isAutomatableEarnDestination,
    makeEarnLabelKey,
    parseEarnPoints,
    parseQuestProgress,
    EarnLinkInput
} from '../src/rewards-api/EarnTaskRunner'

function link(overrides: Partial<EarnLinkInput>): EarnLinkInput {
    return {
        index: 0,
        href: 'https://www.bing.com/search?q=example&form=ML2W4J',
        target: '_blank',
        text: 'Pizza spots nearby\nDiscover the best pizza close to you\n+15',
        ariaLabel: '',
        className: '',
        disabled: false,
        visible: true,
        ...overrides
    }
}

function main(): void {
    assert.strictEqual(parseEarnPoints('Pizza\n+15'), 15)
    assert.strictEqual(parseEarnPoints('Pizza\n+1,320\n4/7 tasks'), 1320)
    assert.strictEqual(parseEarnPoints('Pizza\n15\nCompleted'), 15)
    assert.strictEqual(parseEarnPoints('Wallpaper\nExplore the world'), null)
    assert.strictEqual(hasEarnCompletedMarker('Complete this puzzle\n10\nCompleted'), true)
    assert.strictEqual(hasEarnCompletedMarker('Complete this puzzle\n+10'), false)
    assert.strictEqual(makeEarnLabelKey('Pizza spots nearby\nDiscover the best pizza close to you\n+15'), 'Pizza spots nearby\nDiscover the best pizza close to you')
    assert.deepStrictEqual(parseQuestProgress('Activities\nStatus:\n5/7 tasks'), { current: 5, max: 7 })
    assert.deepStrictEqual(parseQuestProgress('活动\n状态：\n1/4'), { current: 1, max: 4 })
    assert.strictEqual(parseQuestProgress('Status: locked'), null)
    assert.strictEqual(isAutomatableEarnDestination(new URL('https://www.bing.com/search?q=pizza')), true)
    assert.strictEqual(isAutomatableEarnDestination(new URL('https://www.bing.com/spotlight/imagepuzzle?form=ML2UXJ')), true)
    assert.strictEqual(isAutomatableEarnDestination(new URL('https://rewards.bing.com/earn/quest/example')), true)
    assert.strictEqual(isAutomatableEarnDestination(new URL('https://www.bing.com/rewards/checkuser?x=1')), false)
    assert.strictEqual(isAutomatableEarnDestination(new URL('https://bingapp.microsoft.com/bing')), false)

    const tasks = buildEarnTaskSnapshots([
        link({ index: 4 }),
        link({ index: 5, text: 'Complete this puzzle\nArrange the tiles\n+10', href: 'https://www.bing.com/spotlight/imagepuzzle?form=ML2UXJ' }),
        link({ index: 6, text: 'Complete this puzzle\nArrange the tiles\n+5', href: 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0' }),
        link({ index: 7, text: 'Mid-week puzzle\nCan you complete this puzzle?\n+5', href: 'https://www.bing.com/spotlight/imagepuzzle?form=ML2BF0' }),
        link({ index: 8, text: 'Complete this puzzle\nArrange the tiles\n10\nCompleted', href: 'https://www.bing.com/spotlight/imagepuzzle?form=ML2UXJ' }),
        link({ index: 9, text: 'Get started with Rewards\n+1,320\n4/7 tasks', href: 'https://rewards.bing.com/earn/quest/example' }),
        link({ index: 10, text: 'Locked card\n+10', visible: false })
    ], 'https://rewards.bing.com')

    assert.strictEqual(tasks.length, 6)
    assert.strictEqual(tasks.filter(task => task.href.includes('ML2BF0')).length, 2)
    assert.strictEqual(tasks.find(task => task.href.includes('ML2UXJ') && task.completed)?.points, 10)
    assert.strictEqual(tasks.find(task => task.quest)?.quest, true)

    assert.strictEqual(isQuestActionLink({ ariaLabel: 'Earn now, Browse the Earn page', className: 'bg-bgCtrlBrandRest', disabled: false, visible: true }), true)
    assert.strictEqual(isQuestActionLink({ ariaLabel: 'Explore August deals, Click to complete', className: '', disabled: false, visible: true }), true)
    assert.strictEqual(isQuestActionLink({ ariaLabel: 'Explore August deals, Click to complete', className: '', disabled: true, visible: true }), false)
    assert.strictEqual(isQuestActionLink({ ariaLabel: 'Earn', className: 'group/ctrl', disabled: false, visible: true }), false)

    console.log('earn task runner tests passed')
}

try {
    main()
} catch (error) {
    console.error(error)
    process.exitCode = 1
}
