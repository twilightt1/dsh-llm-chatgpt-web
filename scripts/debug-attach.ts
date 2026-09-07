/**
 * Dev-only attach probe: attach a prompt and dump readback details.
 *   node --import tsx/esm scripts/debug-attach.ts
 */
import { chromium } from 'playwright-core'
import { join } from 'node:path'

const profileDir = `${process.env['HOME']}/.dsh-chatgpt-web`
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const PROMPT = '[User]\nReply with exactly: DSH LIVE READY'

const browser = await chromium.launch({
  executablePath: brave,
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  ignoreDefaultArgs: ['--enable-automation'],
})
const context = await browser.newContext({
  storageState: join(profileDir, 'storage-state.json'),
})
await context.addInitScript({ content: `(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {} })()` })
const page = await context.newPage()
await page.goto('https://chatgpt.com/?temporary-chat=true', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(10_000)

const SEL = '#prompt-textarea, [contenteditable="true"].ProseMirror, [role="textbox"][aria-label="Chat with ChatGPT"]'
const composer = page.locator(SEL).filter({ visible: true })
console.log('composer count:', await composer.count())
const first = composer.first()
await first.fill('')
await first.focus()
const inserted = await page.evaluate(
  `(() => {
    const el = document.querySelector('#prompt-textarea');
    const value = ${JSON.stringify(PROMPT)};
    if (!el) return 'no-element';
    if (document.activeElement !== el) el.focus();
    if (document.activeElement !== el) return 'not-focused';
    const sel = window.getSelection();
    if (!sel) return 'no-selection';
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, value);
    return ok ? 'inserted:' + el.innerText.length : 'exec-failed';
  })()`,
)
console.log('insert result:', inserted)
await page.waitForTimeout(1_000)
const innerText = await first.innerText()
console.log('innerText JSON:', JSON.stringify(innerText))
console.log('tail JSON:', JSON.stringify(PROMPT.slice(-120)))
console.log('includes tail:', innerText.includes(PROMPT.slice(-120)))
const html = await first.innerHTML()
console.log('innerHTML (first 800):', html.slice(0, 800))
await page.waitForTimeout(15_000)
await browser.close()
